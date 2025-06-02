// src/visual.ts
"use strict";

// declare require
declare const require: any;

import * as L from "leaflet";
import debounce from "lodash.debounce";
import "leaflet/dist/leaflet.css";
import * as LEsri from "esri-leaflet";

const PruneClusterLib: any = require("@workingfamilies/prune-cluster");
const PruneClusterForLeaflet = PruneClusterLib.ForLeaflet as {
  new(): {
    RemoveMarkers(): void;
    RegisterMarker(m: any): void;
    ProcessView(): void;
    PrepareLeafletMarker?: any;
    BuildLeafletClusterIcon?: any;
  };
};
const PruneClusterMarker = PruneClusterLib.Marker as { new(lat: number, lon: number): any };

import "@workingfamilies/prune-cluster/dist/LeafletStyleSheet.css";
import "./../style/visual.less";

import powerbi from "powerbi-visuals-api";
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;

import isEqual from "fast-deep-equal";
import fipsToCounty from "./data/fipsToCounty";
import counties from "./data/nc_counties";

export class Visual implements IVisual {
  private target!: HTMLElement;
  private host!: IVisualHost;

  private mapContainer!: HTMLElement;
  private map!: L.Map;
  private pruneCluster!: InstanceType<typeof PruneClusterForLeaflet>;
  private countiesLayer!: L.GeoJSON;
  private countyLayers: Record<string, L.Path> = {};
  private hccsLayer?: L.Layer;

  private settings = { selectedMetric: "crashes" as "crashes" | "persons" };
  private previousTableData: powerbi.DataViewTable | null = null;
  private debouncedUpdate: (opts: VisualUpdateOptions) => void;

  constructor(options?: VisualConstructorOptions) {
    if (!options) throw new Error("VisualConstructorOptions must be provided");
    this.target = options.element!;
    this.host = options.host!;

    this.createMapContainer();
    this.initMap();

    this.pruneCluster = new PruneClusterForLeaflet();
    this.map.addLayer(this.pruneCluster as unknown as L.Layer);

    (this.pruneCluster as any).PrepareLeafletMarker = (leafletMarker: L.Marker, data: any) => {
      const v = data.value as number;
      const r = Math.max(3, Math.log10(v + 1) * 10);
      const html = `<div style="width: ${2 * r}px; height: ${2 * r}px; background: #66ccff; border: 1px solid #3366cc; border-radius: 50%; opacity: 0.6;"></div>`;
      leafletMarker.setIcon(L.divIcon({ html, className: "", iconSize: [2 * r, 2 * r] }));
      leafletMarker.bindTooltip(`<strong>Total:</strong> ${v}<br/><strong>County:</strong> ${fipsToCounty[Number(data.fips)] || "Unknown"}`);
    };

    (this.pruneCluster as any).BuildLeafletClusterIcon = (cluster: any) => {
      const total = cluster.totalWeight ?? cluster.population;
      const base = 10 + Math.sqrt(total);
      const r = base * 1.0;
      const color = this.getChoro(total);
      const html = `<div style="width: ${2 * r}px; height: ${2 * r}px; background: ${color}; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: black; font-size: ${Math.min(14, r)}px; font-weight: bold;">${total}</div>`;
      return L.divIcon({ html, className: "", iconSize: [2 * r, 2 * r] });
    };

    this.countiesLayer = L.geoJSON(counties as any, {
      style: {
        interactive: true,
        weight: 1,
        color: "white",
        dashArray: "3",
        fillOpacity: 0.75,
      },
      onEachFeature: (feature, layer) => {
        const fips = feature.properties?.FIPS;
        if (fips != null) this.countyLayers[String(fips)] = layer as L.Path;
      },
    }).addTo(this.map);

    this.map.addControl(
      L.control.layers(undefined, {
        Incidents: this.pruneCluster as unknown as L.Layer,
        Counties: this.countiesLayer
      }, { collapsed: false })
    );

    this.debouncedUpdate = debounce(this.performUpdate.bind(this), 100);
  }

  public update(options: VisualUpdateOptions): void {
    this.debouncedUpdate(options);
  }

  private performUpdate(options: VisualUpdateOptions) {
    const dv = options.dataViews?.[0];
    if (!dv?.table) return;
    if (this.previousTableData && isEqual(this.previousTableData, dv.table)) return;
    this.previousTableData = dv.table;

    this.resizeMap(options);

    const objs = dv.metadata.objects;
    this.settings.selectedMetric = (objs?.dataSelector?.selectedMetric as "crashes" | "persons") || "crashes";

    const rows = dv.table.rows ?? [];
    const cols = dv.table.columns ?? [];
    const latIdx = cols.findIndex(c => c.roles?.y);
    const lonIdx = cols.findIndex(c => c.roles?.x);
    const crashIdx = cols.findIndex(c => c.roles?.crashWeight);
    const fipsIdx = cols.findIndex(c => c.roles?.countyFIPS);
    const interstateIdx = cols.findIndex(c => c.roles?.interstate);
    if (rows.length === 0 || [latIdx, lonIdx, crashIdx, fipsIdx, interstateIdx].some(i => i < 0)) return;

    const crashByFIPS: Record<string, number> = {};
    rows.forEach(r => {
      const f = String(r[fipsIdx] ?? "");
      const v = +r[crashIdx] || 0;
      crashByFIPS[f] = (crashByFIPS[f] || 0) + v;
    });

    Object.entries(this.countyLayers).forEach(([f, layer]) => {
      const val = crashByFIPS[f] || 0;
      const tip = `<strong>${fipsToCounty[Number(f)] || "Unknown County"}</strong><br/><strong>Total:</strong> ${val}`;
      if (layer.getTooltip()?.getContent() !== tip) {
        layer.unbindTooltip().bindTooltip(tip);
      }
      layer.setStyle({ fillColor: this.getColor(val) });
    });

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
    this.countiesLayer.bringToFront();

    const interstates = new Set<string>();
    rows.forEach(row => {
      const val = row[interstateIdx]?.toString().replace(" ", "-");
      if (val != null) interstates.add(String(val));
    });

    if (this.hccsLayer && this.map.hasLayer(this.hccsLayer)) {
      this.map.removeLayer(this.hccsLayer);
    }

    const whereClause = Array.from(interstates).map(s => `'${s}'`).join(", ");
    const where = interstates.size > 0 ? `RouteName IN (${whereClause})` : "1=0";

    this.hccsLayer = LEsri.featureLayer({
      url: "https://ags.coverlab.org/server/rest/services/HighCrashCorridors/HCCs/FeatureServer/0",
      where,
      style: (feature: GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString, any>) => {
        const level = feature?.properties?.IntCorCnty;
        let color = "#cccccc", weight = 2;
        switch (level) {
          case "Low": color = "#ffff00"; weight = 2; break;
          case "Medium": color = "#ff9900"; weight = 3; break;
          case "High": color = "#ff0000"; weight = 4; break;
        }
        return { color, weight, opacity: 0.9 };
      },
      onEachFeature: (feature: GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString, any>, layer: L.Layer) => {
        const props = feature.properties || {};
        const label = Object.keys(props).map(k => `<strong>${k}:</strong> ${props[k]}`).join("<br/>");
        (layer as L.Path).bindTooltip(label, { sticky: true, direction: "top" });
      }
    }).addTo(this.map);
  }

  public destroy(): void {
    this.map.remove();
  }

  private getColor(val: number): string {
    const breaks = [0, 10, 50, 100, 200, 500, 1000];
    return val <= breaks[0] ? "rgba(0,0,0,0)" :
           val <= breaks[1] ? "#ffffcc" :
           val <= breaks[2] ? "#ffeda0" :
           val <= breaks[3] ? "#feb24c" :
           val <= breaks[4] ? "#fd8d3c" :
           val <= breaks[5] ? "#f03b20" :
           val <= breaks[6] ? "#bd0026" : "#800026";
  }

  private getChoro(val: number): string {
    const breaks = [0, 10, 50, 100, 200, 500, 1000];
    return val <= breaks[0] ? "rgba(0,0,0,0)" :
           val <= breaks[1] ? "#4575b4" :
           val <= breaks[2] ? "#74add1" :
           val <= breaks[3] ? "#abd9e9" :
           val <= breaks[4] ? "#fdae61" :
           val <= breaks[5] ? "#f46d43" :
           val <= breaks[6] ? "#d73027" : "#a50026";
  }

  private resizeMap(opts: VisualUpdateOptions) {
    requestAnimationFrame(() => {
      this.mapContainer.style.width = `${opts.viewport.width}px`;
      this.mapContainer.style.height = `${opts.viewport.height}px`;
      this.map.invalidateSize();
    });
  }

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

console.log("Hi");
