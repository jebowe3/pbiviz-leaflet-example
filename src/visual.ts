"use strict";

// import necessary modules and types
import * as powerbiModels from "powerbi-models";
import * as L from "leaflet";
import debounce from "lodash.debounce";
import "leaflet/dist/leaflet.css";
import * as LEsri from "esri-leaflet";
// Import PruneCluster library and types
declare const require: any;
const PruneClusterLib: any = require("@workingfamilies/prune-cluster"); // PruneCluster library is imported dynamically using require
// Define the PruneClusterForLeaflet and PruneClusterMarker types
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
const PruneClusterMarker = PruneClusterLib.Marker as { new(lat: number, lon: number): any }; // This is used to create markers with latitude and longitude
import "@workingfamilies/prune-cluster/dist/LeafletStyleSheet.css";
import "./../style/visual.less";
import powerbi from "powerbi-visuals-api";
// Import necessary Power BI extensibility types
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions; // This is used to define the constructor options for the visual
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions; // This is used to define the update options for the visual
import IVisual = powerbi.extensibility.visual.IVisual; // This is the main interface for the visual
import IVisualHost = powerbi.extensibility.visual.IVisualHost; // This is the host interface that provides access to Power BI services and APIs
// Import isEqual from "fast-deep-equal";
import isEqual from "fast-deep-equal"; // This is used to compare the previous table data with the current data to avoid unnecessary updates
// Import the FIPS to county mapping and counties GeoJSON data from the local src/data files
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
  private countiesLayer!: L.GeoJSON; // This is a GeoJSON layer that contains the county boundaries
  private countyLayers: Record<string, L.Path> = {}; // This is a record to store county layers by FIPS code
  // Layer for high crash corridors
  private hccsLayer?: L.Layer;
  // Flag to track if the high crash corridors layer has been added
  private hccsLayerAdded = false; // This is used to prevent adding the layer multiple times
  // Layer control for managing layers on the map
  private layerControl?: L.Control.Layers;
  // Settings for the visual, including the selected metric (for the switch)
  private settings = { selectedMetric: "crashes" as "crashes" | "persons" };
  // Previous table data to check for changes
  private previousTableData: powerbi.DataViewTable | null = null; // This is used to avoid unnecessary updates when the data has not changed
  // Debounced update function to handle updates efficiently
  private debouncedUpdate: (opts: VisualUpdateOptions) => void;

  // Constructor for the visual class
  // This is called when the visual is created and initializes the map and layers
  constructor(options?: VisualConstructorOptions) {
    // Check if options are provided and throw an error if not
    if (!options) throw new Error("VisualConstructorOptions must be provided"); // This is important to ensure the visual has the necessary context to render correctly
    // Check if the element and host are provided in options
    this.target = options.element!;
    this.host = options.host!;
    // Create the map container element
    this.createMapContainer(); // This is where the Leaflet map will be rendered
    // Initialize the Leaflet map
    this.initMap();

    // Canvas‐cluster layer
    this.pruneCluster = new PruneClusterForLeaflet(); // This initializes the PruneCluster instance for clustering markers
    this.map.addLayer(this.pruneCluster as unknown as L.Layer); // Add the PruneCluster layer to the map
    // Set the cluster options
    (this.pruneCluster as any).PrepareLeafletMarker = (leafletMarker: L.Marker, data: any) => { // This function prepares the Leaflet marker for clustering
      const v = data.value as number; // Get the value from the data
      const r = Math.max(3, Math.log10(v + 1) * 10); // Calculate the radius based on the value, ensuring a minimum radius of 3
      // Create a circular HTML element for the marker icon
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
      // Set the marker icon using a divIcon with the HTML content
      leafletMarker.setIcon(
        L.divIcon({ html, className: "", iconSize: [2 * r, 2 * r] })
      );
      // Bind a tooltip to the marker with the total value and county name
      leafletMarker.bindTooltip(
        `<strong>Total:</strong> ${v}<br/>
         <strong>County:</strong> ${fipsToCounty[Number(data.fips)] || "Unknown"}`
      );
      // On hover, change the border color to yellow and the background to light yellow
      leafletMarker.on("mouseover", () => {
        leafletMarker.setIcon(
          L.divIcon({
            html: `
              <div style="
                width: ${2 * r}px;
                height: ${2 * r}px;
                background: #ffffcc;
                border: 1px solid #ffcc00;
                border-radius: 50%;
                opacity: 0.8;
              "></div>
            `,
            className: "",
            iconSize: [2 * r, 2 * r]
          })
        );
      });
      // On mouseout, reset the border color and background
      leafletMarker.on("mouseout", () => {
        leafletMarker.setIcon(
          L.divIcon({ html, className: "", iconSize: [2 * r, 2 * r] })
        );
      });
    };
    // Build the cluster icon using a custom function
    (this.pruneCluster as any).BuildLeafletClusterIcon = (cluster: any) => { // This function creates a circular icon with the total value displayed inside
      const total = cluster.totalWeight ?? cluster.population; // Get the total value from the cluster, using totalWeight or population
      const base = 10 + Math.sqrt(total); // Calculate the base radius based on the total value, ensuring a minimum size
      const r = base * 1.0; // Calculate the radius for the cluster icon, scaling it by a factor of 1.0 (you can adjust this factor for larger or smaller icons)
      const color = this.getChoro(total); // Get the color based on the total value using the choropleth color function
      // Create a circular HTML element for the cluster icon
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
      // Return a Leaflet divIcon with the HTML content and size
      return L.divIcon({ html, className: "", iconSize: [2 * r, 2 * r] });
    };

    // Counties layer
    this.countiesLayer = L.geoJSON(counties as any, { // This creates a GeoJSON layer for the counties using the provided GeoJSON data
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

    // Layer control (no hccsLayer yet, will be added later after update)
    this.layerControl = L.control.layers(undefined, {
      Incidents: this.pruneCluster as unknown as L.Layer,
      Counties: this.countiesLayer
    }, { collapsed: false }).addTo(this.map);

    // Debounced update
    this.debouncedUpdate = debounce(this.performUpdate.bind(this), 100); // This creates a debounced version of the performUpdate method to avoid excessive updates during rapid changes
  }

  // This method is called when the visual is updated
  // It receives the VisualUpdateOptions which contains the new data and viewport
  public update(options: VisualUpdateOptions): void {
    this.debouncedUpdate(options);
  }

  private retryCount = 0; // This is used to track the number of retries for the INTERSTATE role assignment

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
    const rows = dv.table.rows ?? []; // Get the rows from the table data
    const cols = dv.table.columns ?? []; // Get the columns from the table data
    const latIdx = cols.findIndex(c => c.roles?.y); // Find the index of the latitude column
    const lonIdx = cols.findIndex(c => c.roles?.x); // Find the index of the longitude column
    const crashIdx = cols.findIndex(c => c.roles?.crashWeight); // Find the index of the crash weight column
    const fipsIdx = cols.findIndex(c => c.roles?.countyFIPS); // Find the index of the county FIPS column
    const interstateIdx = cols.findIndex(c => c.roles?.interstate); // Find the index of the interstate column

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

    // If no interstates are selected, fallback to reading from the table rows
    // This ensures that if no filters are applied, we still get all interstates from the data
    if (selectedInterstates.size === 0 && interstateIdx >= 0) {
      // Iterate through rows to collect interstate values
      rows.forEach(row => {
        const val = row[interstateIdx]?.toString()?.trim(); // Get the interstate value from the row
        if (val) selectedInterstates.add(val); // Add it to the set if it's not empty
      });
    }

    // Ensure we have valid indices for latitude, longitude, crash weight, and FIPS
    if (rows.length === 0 || [latIdx, lonIdx, crashIdx, fipsIdx].some(i => i < 0)) return; 

    // Aggregate by FIPS
    const crashByFIPS: Record<string, number> = {};
    // Iterate through rows to aggregate crash counts by FIPS
    rows.forEach(r => {
      const f = String(r[fipsIdx] ?? ""); // Get the FIPS code from the row, defaulting to an empty string if not found
      const v = +r[crashIdx] || 0; // Get the switch value from the row, defaulting to 0 if not found
      crashByFIPS[f] = (crashByFIPS[f] || 0) + v; // Aggregate the counts by FIPS code
    });

    // County choropleth
    Object.entries(this.countyLayers).forEach(([f, layer]) => { // Iterate through each county layer
      const val = crashByFIPS[f] || 0; // Get the aggregated count for the county, defaulting to 0 if not found
      const tip = `<strong>${fipsToCounty[Number(f)] || "Unknown County"}</strong><br/>
                 <strong>Total:</strong> ${val}`; // Create a tooltip with the county name and total value
      // Check if the tooltip content is different before updating
      // This prevents unnecessary updates to the tooltip content
      // This is important to avoid flickering or performance issues when the tooltip content does not change           
      if (layer.getTooltip()?.getContent() !== tip) {
        layer.unbindTooltip().bindTooltip(tip); // Unbind any existing tooltip and bind a new one with the updated content
      }
      // Set the fill color for the county layer based on the value
      layer.setStyle({ fillColor: this.getColor(val) });
      // On hover, 
      layer.on("mouseover", () => {
        // Set layer styles
        layer.setStyle({
          fillOpacity: 0.9,
          color: "yellow",
          weight: 2
        });
      });
      // On mouseout, 
      layer.on("mouseout", () => {
        // Reset layer styles to default
        layer.setStyle({
          fillOpacity: 0.75,
          color: "gray",
          weight: 1
        });
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
        // Check if the bounds are valid (not empty)
        if (bounds.isValid()) {
          // Add the bounds to the array
          countyBounds.push(bounds);
        }
      }
    });

    // If we have at least one valid county layer, zoom to it
    if (countyBounds.length > 0) {
      const combinedBounds = countyBounds.reduce((acc, b) => acc.extend(b), countyBounds[0]); // Combine all bounds into one
      this.map.fitBounds(combinedBounds.pad(0.1)); // Add 10% padding
    }

    // Rebuild clusters
    this.pruneCluster.RemoveMarkers();
    // Iterate through rows to create markers for the clusters
    // Each marker represents an incident with its latitude, longitude, and value
    rows.forEach(r => {
      const lat = +r[latIdx], lon = +r[lonIdx]; // Get the latitude and longitude from the row
      if (isNaN(lat) || isNaN(lon)) return; // Skip if latitude or longitude is not a number
      const v = +r[crashIdx] || 0; // Get the switch value from the row, defaulting to 0 if not found
      const f = String(r[fipsIdx] ?? "").padStart(5, "0"); // Get the FIPS code from the row, defaulting to an empty string if not found
      const m = new PruneClusterMarker(lat, lon); // Create a new PruneClusterMarker with the latitude and longitude
      m.data = { fips: f, value: v }; // Attach data to the marker, including FIPS code and value
      m.weight = v; // Set the weight of the marker to the value
      this.pruneCluster.RegisterMarker(m); // Register the marker with the PruneCluster instance
    });
    this.pruneCluster.ProcessView(); // Process the view to update the clusters

    // Rebuild hccsLayer safely
    if (this.hccsLayer && this.map.hasLayer(this.hccsLayer)) { // Check if the hccsLayer exists and is currently on the map
      this.map.removeLayer(this.hccsLayer); // Remove the existing hccsLayer from the map

      // Rebuild LayerControl to remove old entry
      if (this.layerControl && this.hccsLayerAdded) {
        this.map.removeControl(this.layerControl); // Remove the existing layer control
        this.layerControl = L.control.layers(undefined, { // Rebuild the layer control with the current layers
          Incidents: this.pruneCluster as unknown as L.Layer,
          Counties: this.countiesLayer
        }, { collapsed: false }).addTo(this.map);
        this.hccsLayerAdded = false; // Reset the flag since we are rebuilding the layer control
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
        // Create a label with properties
        const label = `
          <strong>Route:</strong> ${props.RouteName || "Unknown"}<br/>
          <strong>Troop:</strong> ${props.Troop || "Unknown"}<br/>
          <strong>Level:</strong> ${props.IntCorCnty || "Unknown"}<br/>
        `;

        //const label = Object.keys(props).map(k => `<strong>${k}:</strong> ${props[k]}`).join("<br/>");
        (layer as L.Path).bindTooltip(label, { sticky: true, direction: "top" });

        // On hover, add 1 to weight value
        layer.on("mouseover", () => {
          const currentWeight = (layer as L.Path).options.weight || 2; // Default weight is 2 because typescript needs a fallback
          (layer as L.Path).setStyle({ weight: currentWeight * 2 });
        });
        // On mouseout, reset weight to original value
        layer.on("mouseout", () => {
          const currentWeight = (layer as L.Path).options.weight || 2; // Default weight is 2 because typescript needs a fallback
          (layer as L.Path).setStyle({ weight: currentWeight / 2 });
        });
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
      center: [35.54, -79.24], // Default center coordinates for North Carolina
      zoom: 7, // Default zoom level
      maxZoom: 20, // Maximum zoom level
      minZoom: 3 // Minimum zoom level
    });
    // Add OpenStreetMap tile layer to the map
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 20,
      attribution: '© OpenStreetMap contributors'
    }).addTo(this.map);
  }
}