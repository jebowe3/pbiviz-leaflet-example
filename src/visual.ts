"use strict";

// import necessary modules and types
import * as powerbiModels from "powerbi-models";
import * as L from "leaflet";
import debounce from "lodash.debounce";
import "leaflet/dist/leaflet.css";
import * as LEsri from "esri-leaflet";

// Import PruneCluster library and types
// Note: The PruneCluster library is dynamically imported using require.
declare const require: any;
const PruneClusterLib: any = require("@workingfamilies/prune-cluster");
// Define the PruneClusterForLeaflet and PruneClusterMarker types
// These types are used to create instances of PruneCluster for Leaflet and markers
const PruneClusterForLeaflet = PruneClusterLib.ForLeaflet as {
  new(): {
    RemoveMarkers(): void;
    RegisterMarker(m: any): void;
    ProcessView(): void;
    PrepareLeafletMarker?: any;
    BuildLeafletClusterIcon?: any;
  };
};
// Define the PruneClusterMarker type
// This is used to create markers with latitude and longitude
const PruneClusterMarker = PruneClusterLib.Marker as { new(lat: number, lon: number): any };

import "@workingfamilies/prune-cluster/dist/LeafletStyleSheet.css";
import "./../style/visual.less";

import powerbi from "powerbi-visuals-api";
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;

import isEqual from "fast-deep-equal";
// Import the FIPS to county mapping and counties GeoJSON data
// These are used to map FIPS codes to county names and provide the GeoJSON for counties
import fipsToCounty from "./data/fipsToCounty";
import counties from "./data/nc_counties";

// Define the visual class that implements IVisual
export class Visual implements IVisual {
  // Define the properties of the visual class
  // These properties are used to store the target element, host, map container, map instance, and layers
  private target!: HTMLElement;
  private host!: IVisualHost;
  private mapContainer!: HTMLElement;
  private map!: L.Map;
  // PruneClusterForLeaflet instance for clustering markers
  private pruneCluster!: InstanceType<typeof PruneClusterForLeaflet>;
  // Layer for county boundaries
  private countiesLayer!: L.GeoJSON;
  private countyLayers: Record<string, L.Path> = {};
  // Layer for high crash corridors
  private hccsLayer?: L.Layer;
  // Flag to track if the high crash corridors layer has been added
  // This is used to prevent adding the layer multiple times
  private hccsLayerAdded = false;
  // Layer control for managing layers on the map
  private layerControl?: L.Control.Layers;
  // Settings for the visual, including the selected metric
  private settings = { selectedMetric: "crashes" as "crashes" | "persons" };
  // Previous table data to check for changes
  // This is used to avoid unnecessary updates when the data has not changed
  private previousTableData: powerbi.DataViewTable | null = null;
  // Debounced update function to handle updates efficiently
  private debouncedUpdate: (opts: VisualUpdateOptions) => void;

  // Constructor for the visual class
  // This is called when the visual is created and initializes the map and layers
  constructor(options?: VisualConstructorOptions) {
    // Check if options are provided and throw an error if not
    // This is important to ensure the visual has the necessary context to render correctly
    if (!options) throw new Error("VisualConstructorOptions must be provided");
    // Check if the element and host are provided in options
    this.target = options.element!;
    this.host = options.host!;
    // Create the map container element
    // This is where the Leaflet map will be rendered
    this.createMapContainer();
    // Initialize the Leaflet map
    this.initMap();

    // Canvas‐cluster layer
    this.pruneCluster = new PruneClusterForLeaflet();
    this.map.addLayer(this.pruneCluster as unknown as L.Layer);
    // Set the cluster options
    (this.pruneCluster as any).PrepareLeafletMarker = (leafletMarker: L.Marker, data: any) => {
      const v = data.value as number;
      const r = Math.max(3, Math.log10(v + 1) * 10);
      const html = `
        <div style="
          width: ${2 * r}px;
          height: ${2 * r}px;
          background: #66ccff;
          border: 1px solid #3366cc;
          border-radius: 50%;
          opacity: 0.6;
        "></div>
      `;
      leafletMarker.setIcon(
        L.divIcon({ html, className: "", iconSize: [2 * r, 2 * r] })
      );
      leafletMarker.bindTooltip(
        `<strong>Total:</strong> ${v}<br/>
         <strong>County:</strong> ${fipsToCounty[Number(data.fips)] || "Unknown"}`
      );
    };
    // Build the cluster icon using a custom function
    // This function creates a circular icon with the total value displayed inside
    (this.pruneCluster as any).BuildLeafletClusterIcon = (cluster: any) => {
      const total = cluster.totalWeight ?? cluster.population;
      const base = 10 + Math.sqrt(total);
      const r = base * 1.0;
      const color = this.getChoro(total);
      const html = `
        <div style="
          width: ${2 * r}px;
          height: ${2 * r}px;
          background: ${color};
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          color: black;
          font-size: ${Math.min(14, r)}px;
          font-weight: bold;
        ">${total}</div>
      `;
      return L.divIcon({ html, className: "", iconSize: [2 * r, 2 * r] });
    };

    // County choropleth layer
    this.countiesLayer = L.geoJSON(counties as any, {
      style: {
        interactive: true,
        weight: 1,
        color: "gray",
        dashArray: "3",
        fillOpacity: 0.75,
      },
      onEachFeature: (feature, layer) => {
        const fips = feature.properties?.FIPS;
        if (fips != null) this.countyLayers[String(fips)] = layer as L.Path;
      },
    }).addTo(this.map);

    // Layer control (static layers only)
    this.layerControl = L.control.layers(undefined, {
      Incidents: this.pruneCluster as unknown as L.Layer,
      Counties: this.countiesLayer
    }, { collapsed: false }).addTo(this.map);

    // Debounced update
    this.debouncedUpdate = debounce(this.performUpdate.bind(this), 100);
  }

  // This method is called when the visual is updated
  // It receives the VisualUpdateOptions which contains the new data and viewport
  public update(options: VisualUpdateOptions): void {
    this.debouncedUpdate(options);
  }

  private retryCount = 0;

  // This method performs the actual update logic
  private performUpdate(options: VisualUpdateOptions) {

    // Check if the dataViews are available and if the table data has changed
    const dv = options.dataViews?.[0];
    if (!dv?.table) return;
    if (this.previousTableData && isEqual(this.previousTableData, dv.table)) return;
    this.previousTableData = dv.table;

    // Resize the map to fit the Power BI viewport
    this.resizeMap(options);

    const objs = dv.metadata.objects;
    this.settings.selectedMetric =
      (objs?.dataSelector?.selectedMetric as "crashes" | "persons") || "crashes";

    // define roles for latitude, longitude, crash weight, county FIPS, and interstate
    const rows = dv.table.rows ?? [];
    const cols = dv.table.columns ?? [];
    const latIdx = cols.findIndex(c => c.roles?.y);
    const lonIdx = cols.findIndex(c => c.roles?.x);
    const crashIdx = cols.findIndex(c => c.roles?.crashWeight);
    const fipsIdx = cols.findIndex(c => c.roles?.countyFIPS);
    const interstateIdx = cols.findIndex(c => c.roles?.interstate);

    // Log the indices for debugging
    if (interstateIdx < 0) {
      if (this.retryCount < 5) {
        this.retryCount++;
        console.warn(`INTERSTATE role not assigned. Retry ${this.retryCount}/5...`);
        setTimeout(() => this.performUpdate(options), 500);
      } else {
        console.error("INTERSTATE role still not assigned after retries.");
      }
      return;
    }

    this.retryCount = 0; // Reset on success



    // Read INTERSTATE from Filters API
    const jsonFilters = options.jsonFilters as powerbiModels.IFilter[];

    // Collect all selected INTERSTATE values from filters
    const selectedInterstates = new Set<string>();

    // Iterate through filters to find INTERSTATE selections
    for (const filter of jsonFilters) {
      // Check if the filter is a basic filter
      if (filter.filterType === powerbiModels.FilterType.Basic) {
        // Ensure the filter is an IBasicFilter
        const basicFilter = filter as powerbiModels.IBasicFilter;
        // Check if the target is an array or a single value
        const targets = Array.isArray(basicFilter.target) ? basicFilter.target : [basicFilter.target];
        // Iterate through targets to find INTERSTATE
        for (const target of targets) {
          // Check if the target has a column and it matches "interstate"
          const col = (target as any).column?.toLowerCase?.();
          if (col === "interstate") {
            // If it matches, add all selected values to the set
            basicFilter.values?.forEach(val => {
              if (val != null) {
                selectedInterstates.add(String(val).trim());
              }
            });
          }
        }
      }
    }

    // Fallback to rows[] if needed
    if (selectedInterstates.size === 0 && interstateIdx >= 0) {
      console.log("Fallback: trying rows[] for INTERSTATE");
      rows.forEach(row => {
        const val = row[interstateIdx]?.toString()?.trim();
        if (val) selectedInterstates.add(val);
      });
      console.log("Selected INTERSTATE from rows fallback:", selectedInterstates);
    }

    if (rows.length === 0 || [latIdx, lonIdx, crashIdx, fipsIdx].some(i => i < 0)) return;

    // Aggregate by FIPS
    const crashByFIPS: Record<string, number> = {};
    rows.forEach(r => {
      const f = String(r[fipsIdx] ?? "");
      const v = +r[crashIdx] || 0;
      crashByFIPS[f] = (crashByFIPS[f] || 0) + v;
    });

    // County choropleth
    Object.entries(this.countyLayers).forEach(([f, layer]) => {
      const val = crashByFIPS[f] || 0;
      const tip = `<strong>${fipsToCounty[Number(f)] || "Unknown County"}</strong><br/>
                 <strong>Total:</strong> ${val}`;
      if (layer.getTooltip()?.getContent() !== tip) {
        layer.unbindTooltip().bindTooltip(tip);
      }
      layer.setStyle({ fillColor: this.getColor(val) });
      // on hover, 
      layer.on("mouseover", () => {
        // change opacity to 0.9
        layer.setStyle({ fillOpacity: 0.9 });
        // set the county boundary color to yellow
        layer.setStyle({ color: "yellow", weight: 2 });
      });
      // on mouseout, 
      layer.on("mouseout", () => {
        // reset opacity to 0.75
        layer.setStyle({ fillOpacity: 0.75 });
        // reset the county boundary color to gray
        layer.setStyle({ color: "gray", weight: 1 });
      });
    });

    // Collect filtered FIPS codes from current dataset
    const filteredFIPS = new Set<string>();
    rows.forEach(r => {
      const fips = String(r[fipsIdx] ?? "").padStart(5, "0");
      if (fips) filteredFIPS.add(fips);
    });

    // Build bounds for filtered counties
    const countyBounds = [] as L.LatLngBounds[];

    // Iterate through filtered FIPS codes and collect bounds
    filteredFIPS.forEach(fips => {
      const layer = this.countyLayers[fips];
      // Check if the layer exists and has a getBounds method
      if (layer && typeof (layer as any).getBounds === "function") {
        // Get the bounds of the layer and check if it's valid
        const bounds = (layer as any).getBounds() as L.LatLngBounds;
        if (bounds.isValid()) {
          // Add the bounds to the array
          countyBounds.push(bounds);
        }
      }
    });

    // If we have at least one valid county layer, zoom to it
    if (countyBounds.length > 0) {
      const combinedBounds = countyBounds.reduce((acc, b) => acc.extend(b), countyBounds[0]);
      this.map.fitBounds(combinedBounds.pad(0.1)); // Add 10% padding
    }

    // Rebuild clusters
    this.pruneCluster.RemoveMarkers();
    rows.forEach(r => {
      const lat = +r[latIdx], lon = +r[lonIdx];
      if (isNaN(lat) || isNaN(lon)) return;
      const v = +r[crashIdx] || 0;
      const f = String(r[fipsIdx] ?? "").padStart(5, "0");
      const m = new PruneClusterMarker(lat, lon);
      m.data = { fips: f, value: v };
      m.weight = v;
      this.pruneCluster.RegisterMarker(m);
    });
    this.pruneCluster.ProcessView();

    // Rebuild hccsLayer safely — FULL CLEAN pattern
    if (this.hccsLayer && this.map.hasLayer(this.hccsLayer)) {
      this.map.removeLayer(this.hccsLayer);

      // Rebuild LayerControl to remove old entry
      if (this.layerControl && this.hccsLayerAdded) {
        this.map.removeControl(this.layerControl);
        this.layerControl = L.control.layers(undefined, {
          Incidents: this.pruneCluster as unknown as L.Layer,
          Counties: this.countiesLayer
        }, { collapsed: false }).addTo(this.map);
        this.hccsLayerAdded = false;
      }
    }

    // Make SQL safe
    // Build a Set of all the valid interstates in dash‐notation.
    const VALID_ROUTES = new Set([
      "I-26", "I-40", "I-77", "I-85", "I-95"
    ]);

    // Normalize each selection: replace any whitespace (one or more chars) with a single dash.
    // Then check against the list. Only keep those that match exactly.
    const safeInterstates = Array.from(selectedInterstates)
      .map(raw => {
        // Trim and replace whitespace with a single dash
        const normalized = raw.trim().replace(/\s+/g, "-");
        return normalized;
      })
      .filter(norm => VALID_ROUTES.has(norm));

    // Build the WHERE clause from the safe list (or “1=0” if nothing matched).
    let where;
    if (safeInterstates.length > 0) {
      const whereClause = safeInterstates
        .map(r => `'${r}'`)
        .join(", ");
      where = `RouteName IN (${whereClause})`;
    } else {
      // If no valid interstates remain after normalization, force an always‐false filter.
      where = "1=0";
    }

    // Rebuild the hccsLayer with the WHERE clause
    this.hccsLayer = LEsri.featureLayer({
      url: "https://ags.coverlab.org/server/rest/services/HighCrashCorridors/HCCs/FeatureServer/0",
      where,
      style: function (feature: GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString, any>): L.PathOptions {
        const level = feature?.properties?.IntCorCnty;
        // Set default color and weight
        let color = "#cccccc", weight = 2;
        // Set color and weight based on level
        switch (level) {
          case "Low": color = "#ffff00"; weight = 2; break;
          case "Medium": color = "#ff9900"; weight = 3; break;
          case "High": color = "#ff0000"; weight = 4; break;
        }
        return { color, weight, opacity: 0.9 };
      },
      onEachFeature: (feature: GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString, any>, layer: L.Layer) => {
        // Define the properties
        const props = feature.properties || {};
        console.log("HCCs properties:", props);
        // Create a label with properties
        const label = `
          <strong>Route:</strong> ${props.RouteName || "Unknown"}<br/>
          <strong>Level:</strong> ${props.IntCorCnty || "Unknown"}<br/>
        `;

        //const label = Object.keys(props).map(k => `<strong>${k}:</strong> ${props[k]}`).join("<br/>");
        (layer as L.Path).bindTooltip(label, { sticky: true, direction: "top" });
      }
    }).addTo(this.map);

    // Add to LayerControl once
    if (this.layerControl && this.hccsLayer && !this.hccsLayerAdded) {
      this.layerControl.addOverlay(this.hccsLayer, "High Crash Corridors");
      this.hccsLayerAdded = true;
    }

    // Enforce Z-order
    this.countiesLayer.bringToBack();

    if (this.hccsLayer) {
      (this.hccsLayer as any).bringToFront();
    }

    // Process the cluster view
    this.pruneCluster.ProcessView();

  }

  // Clean up resources when the visual is destroyed
  // This is called when the visual is removed from the report or the page is unloaded
  public destroy(): void {
    this.map.remove();
  }

  // Get the color based on value
  // This is used for marker colors in the cluster
  private getColor(val: number): string {
    const breaks = [0, 10, 50, 100, 200, 500, 1000];
    return val <= breaks[0] ? "rgba(0,0,0,0)" :
      val <= breaks[1] ? "#ffffcc" :
        val <= breaks[2] ? "#ffeda0" :
          val <= breaks[3] ? "#feb24c" :
            val <= breaks[4] ? "#fd8d3c" :
              val <= breaks[5] ? "#f03b20" :
                val <= breaks[6] ? "#bd0026" :
                  "#800026";
  }

  // Get the choropleth color based on value
  // This is used for county fill colors
  private getChoro(val: number): string {
    const breaks = [0, 10, 50, 100, 200, 500, 1000];
    return val <= breaks[0] ? "rgba(0,0,0,0)" :
      val <= breaks[1] ? "#4575b4" :
        val <= breaks[2] ? "#74add1" :
          val <= breaks[3] ? "#abd9e9" :
            val <= breaks[4] ? "#fdae61" :
              val <= breaks[5] ? "#f46d43" :
                val <= breaks[6] ? "#d73027" :
                  "#a50026";
  }

  // Resize the map container to match the Power BI viewport
  // This is called during updates to ensure the map fits the available space
  private resizeMap(opts: VisualUpdateOptions) {
    requestAnimationFrame(() => {
      this.mapContainer.style.width = `${opts.viewport.width}px`;
      this.mapContainer.style.height = `${opts.viewport.height}px`;
      this.map.invalidateSize();
    });
  }

  // Create the map container element
  // This is called during initialization and whenever the map needs to be recreated
  private createMapContainer() {
    const existing = document.getElementById("mapid");
    if (existing) existing.remove();
    const div = document.createElement("div");
    div.id = "mapid";
    div.style.width = "100%";
    div.style.height = "100%";
    this.target.appendChild(div);
    this.mapContainer = div;
  }

  // Initialize the Leaflet map
  private initMap() {
    this.map = L.map("mapid", {
      preferCanvas: true,
      center: [35.54, -79.24],
      zoom: 7,
      maxZoom: 20,
      minZoom: 3
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 20,
      attribution: '© OpenStreetMap contributors'
    }).addTo(this.map);
  }
}