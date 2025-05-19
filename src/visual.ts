"use strict";
import "leaflet/dist/leaflet.css";
import "./../style/visual.less";
import powerbi from "powerbi-visuals-api";
import EnumerateVisualObjectInstancesOptions = powerbi.EnumerateVisualObjectInstancesOptions;
import VisualObjectInstanceEnumeration = powerbi.VisualObjectInstanceEnumeration;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import * as L from "leaflet";

import fipsToCounty from "./data/fipsToCounty";
import counties from "./data/nc_counties"; // GeoJSON

export class Visual implements IVisual {
    private mapContainer: HTMLElement;
    private map: L.Map;
    private target: HTMLElement;
    private host: IVisualHost;
    private layerControl: L.Control.Layers;
    private dataPointsLayer: L.LayerGroup;
    private countiesLayer: L.GeoJSON | null = null;
    private settings = {
        selectedMetric: "crashes" as "crashes" | "persons"
    };

    constructor(options: VisualConstructorOptions) {
        this.target = options.element;
        this.host = options.host;
        this.createMapContainer();
        this.initMap();

        // initialize points layer on canvas overlay
        this.dataPointsLayer = L.layerGroup().addTo(this.map);

        // setup layer control; counties overlay added in first update
        this.layerControl = L.control.layers(null, { "Incidents": this.dataPointsLayer }, { collapsed: false }).addTo(this.map);
    }

    public update(options: VisualUpdateOptions): void {
        this.resizeMap(options);
        const dataView = options.dataViews?.[0];
        const objects = dataView?.metadata?.objects;
        this.settings.selectedMetric = (objects?.dataSelector?.selectedMetric as "crashes" | "persons") || "crashes";

        const rows = dataView?.table?.rows || [];
        const columns = dataView?.table?.columns || [];

        const latIndex = columns.findIndex(c => c.roles?.y);
        const lonIndex = columns.findIndex(c => c.roles?.x);
        const crashIndex = columns.findIndex(c => c.roles?.crashWeight);
        const personsIndex = columns.findIndex(c => c.roles?.personsPerCrash);
        const fipsIndex = columns.findIndex(c => c.roles?.countyFIPS);

        const activeMetricIndex = this.settings.selectedMetric === "crashes" ? crashIndex : personsIndex;

        if (rows.length === 0 || latIndex === -1 || lonIndex === -1) {
            console.warn("❌ Required data is missing or not mapped correctly.");
            return;
        }

        // compute per-county totals
        const crashByFIPS: Record<string, number> = {};
        for (const row of rows) {
            const f = row[fipsIndex];
            const v = +row[activeMetricIndex] || 0;
            if (f != null) {
                const key = String(f);
                crashByFIPS[key] = (crashByFIPS[key] || 0) + v;
            }
        }

        // hard-coded breaks for seven classes
        const breaks = [0, 50, 100, 500, 1000, 5000, 10000];

        // color function based on static breaks
        const getColor = (value: number, b: number[]): string => {
            if (value <= b[1]) return "#ffffcc";
            if (value <= b[2]) return "#ffeda0";
            if (value <= b[3]) return "#feb24c";
            if (value <= b[4]) return "#fd8d3c";
            if (value <= b[5]) return "#f03b20";
            if (value <= b[6]) return "#bd0026";
            return "#800026";
        };

        // style and tooltip for counties
        const styleCounty = (feature: any) => {
            const f = feature.properties?.FIPS;
            const val = crashByFIPS[String(f)] || 0;
            return {
                interactive: true,
                fillColor: getColor(val, breaks),
                weight: 1,
                color: "white",
                dashArray: "3",
                fillOpacity: 0.5
            };
        };
        const bindCountyTooltip = (feature: any, layer: L.Layer) => {
            const f = feature.properties?.FIPS;
            const val = crashByFIPS[String(f)] || 0;
            const name = fipsToCounty[Number(f)] || "Unknown County";
            layer.bindTooltip(`<strong>${name}</strong><br><strong>Total:</strong> ${val}`);
        };

        // create or update counties layer
        if (!this.countiesLayer) {
            this.countiesLayer = L.geoJSON(counties, {
                style: styleCounty,
                onEachFeature: bindCountyTooltip
            }).addTo(this.map);
            this.layerControl.addOverlay(this.countiesLayer, "Counties");
        } else {
            this.countiesLayer.setStyle(styleCounty);
            this.countiesLayer.eachLayer((layer: any) => {
                const feature = layer.feature;
                const f = feature.properties?.FIPS;
                const val = crashByFIPS[String(f)] || 0;
                const name = fipsToCounty[Number(f)] || "Unknown County";
                layer.unbindTooltip();
                layer.bindTooltip(`<strong>${name}</strong><br><strong>Total:</strong> ${val}`);
            });
        }

        // rebuild incident markers
        this.dataPointsLayer.clearLayers();
        for (const row of rows) {
            const lat = parseFloat(String(row[latIndex]));
            const lon = parseFloat(String(row[lonIndex]));
            if (isNaN(lat) || isNaN(lon)) continue;

            const f = row[fipsIndex];
            const val = +row[activeMetricIndex] || 0;
            let name = "Unknown County";
            if (f != null && !isNaN(Number(f))) {
                name = fipsToCounty[Number(f)] || name;
            }

            const marker = L.circleMarker([lat, lon], {
                radius: Math.max(5, Math.sqrt(val) * 2),
                color: "#3366cc",
                fillColor: "#66ccff",
                fillOpacity: 0.6,
                weight: 1,
                interactive: true
            });
            marker.bindTooltip(`<strong>Total:</strong> ${val}<br><strong>County:</strong> ${name}`);
            marker.on("mouseover", () => marker.setStyle({ color: "#ffff00", fillColor: "#ffff99", weight: 2 }));
            marker.on("mouseout", () => marker.setStyle({ color: "#3366cc", fillColor: "#66ccff", weight: 1 }));
            this.dataPointsLayer.addLayer(marker);
        }
    }

    public destroy(): void {
        this.map?.remove();
    }

    public enumerateObjectInstances(options: EnumerateVisualObjectInstancesOptions): VisualObjectInstanceEnumeration {
        if (options.objectName === "dataSelector") {
            return [{
                objectName: "dataSelector",
                properties: { selectedMetric: this.settings.selectedMetric },
                selector: null
            }];
        }
        return [];
    }

    private createMapContainer(): void {
        const existing = document.getElementById("mapid");
        if (existing) existing.remove();
        const div = document.createElement("div");
        div.id = "mapid";
        div.style.width = "100%";
        div.style.height = "100%";
        this.mapContainer = div;
        this.target.appendChild(div);
    }

    private initMap(): void {
        this.map = L.map("mapid", { preferCanvas: true }).setView([35.5398, -79.2417], 7);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: '&copy; OpenStreetMap contributors'
        }).addTo(this.map);
    }

    private resizeMap(options: VisualUpdateOptions): void {
        this.mapContainer.style.width = options.viewport.width + "px";
        this.mapContainer.style.height = options.viewport.height + "px";
        this.map.invalidateSize();
    }
}

console.log("Visual loaded and running.");
