"use strict";
/// <reference types="leaflet.markercluster" />
import * as L from "leaflet";
import debounce from 'lodash.debounce';
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import "./../style/visual.less";
import powerbi from "powerbi-visuals-api";
import EnumerateVisualObjectInstancesOptions = powerbi.EnumerateVisualObjectInstancesOptions;
import VisualObjectInstanceEnumeration = powerbi.VisualObjectInstanceEnumeration;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;

import type { Feature } from 'geojson';
import type { PathOptions, Layer } from 'leaflet';

import fipsToCounty from "./data/fipsToCounty";
import counties from "./data/nc_counties"; // GeoJSON

export class Visual implements IVisual {
    private mapContainer!: HTMLElement;
    private map!: L.Map;
    private target!: HTMLElement;
    private host!: IVisualHost;
    private layerControl!: L.Control.Layers;
    private markerClusters!: L.MarkerClusterGroup;
    private countiesLayer!: L.GeoJSON;
    private countyLayers: Record<string, L.Path> = {};
    private settings = {
        selectedMetric: "crashes" as "crashes" | "persons"
    };
    private debouncedUpdate: (options: VisualUpdateOptions) => void;

    constructor(options?: VisualConstructorOptions) {
        if (!options) {
            throw new Error("VisualConstructorOptions must be provided by PBIViz");
        }
        this.target = options.element;
        this.host = options.host;

        this.createMapContainer();
        this.initMap();

        // Initialize cluster group
        this.markerClusters = L.markerClusterGroup({
            chunkedLoading: true,
            chunkInterval: 80,
            chunkDelay: 15,
            removeOutsideVisibleBounds: true,
            disableClusteringAtZoom: 14,
            maxClusterRadius: 40,
            showCoverageOnHover: false
        }).addTo(this.map);

        // Initialize counties layer only once
        this.countiesLayer = L.geoJSON(counties, {
            style: { interactive: true, weight: 1, color: "white", dashArray: "3", fillOpacity: 0.5 },
            onEachFeature: (feature, layer) => {
                const fips = feature.properties?.FIPS;
                if (fips) {
                    this.countyLayers[fips] = layer as L.Path;
                }
            }
        }).addTo(this.map);

        // Layer control
        this.layerControl = L.control.layers(undefined, {
            "Incident Clusters": this.markerClusters,
            "Counties": this.countiesLayer
        }, { collapsed: false }).addTo(this.map);

        // Debounced update method
        this.debouncedUpdate = debounce(this.performUpdate.bind(this), 200);
    }

    public update(options: VisualUpdateOptions): void {
        this.debouncedUpdate(options);
    }

    private performUpdate(options: VisualUpdateOptions): void {
        this.resizeMap(options);
        const dataView = options.dataViews?.[0];
        const objects = dataView?.metadata?.objects;
        this.settings.selectedMetric =
            (objects?.dataSelector?.selectedMetric as "crashes" | "persons") ||
            "crashes";

        const rows = dataView?.table?.rows || [];
        const columns = dataView?.table?.columns || [];

        const latIndex = columns.findIndex(c => c.roles?.y);
        const lonIndex = columns.findIndex(c => c.roles?.x);
        const crashIndex = columns.findIndex(c => c.roles?.crashWeight);
        const fipsIndex = columns.findIndex(c => c.roles?.countyFIPS);

        if (rows.length === 0 || latIndex === -1 || lonIndex === -1) return;

        // Compute totals per county
        const crashByFIPS: Record<string, number> = {};
        rows.forEach(row => {
            const f = row[fipsIndex];
            const v = +row[crashIndex] || 0;
            if (f != null) crashByFIPS[String(f)] = (crashByFIPS[String(f)] || 0) + v;
        });

        // Choropleth styling helpers
        const breaks = [0, 50, 100, 500, 1000, 5000, 10000];
        const getColor = (val: number): string =>
            val <= breaks[0] ? "rgba(0,0,0,0)" : val <= breaks[1] ? "#ffffcc" : val <= breaks[2] ? "#ffeda0" :
            val <= breaks[3] ? "#feb24c" : val <= breaks[4] ? "#fd8d3c" : val <= breaks[5] ? "#f03b20" :
            val <= breaks[6] ? "#bd0026" : "#800026";

        // Optimized tooltip and style updates
        Object.entries(this.countyLayers).forEach(([fips, layer]) => {
            const val = crashByFIPS[fips] || 0;
            const tooltipContent = `<strong>${fipsToCounty[Number(fips)] || 'Unknown County'}</strong><br/><strong>Total:</strong> ${val}`;
            if (layer.getTooltip()?.getContent() !== tooltipContent) {
                layer.unbindTooltip().bindTooltip(tooltipContent);
            }
            layer.setStyle({ fillColor: getColor(val) });
        });

        // Efficiently rebuild marker clusters
        this.markerClusters.clearLayers();
        rows.forEach(row => {
            const lat = parseFloat(String(row[latIndex])), lon = parseFloat(String(row[lonIndex]));
            if (isNaN(lat) || isNaN(lon)) return;
            const v = +row[crashIndex] || 0, f = String(row[fipsIndex] ?? '');
            const marker = L.circleMarker([lat, lon], {
                radius: Math.max(3, Math.sqrt(v)),
                color: "#3366cc",
                fillColor: "#66ccff",
                fillOpacity: 0.6,
                weight: 1
            }).bindTooltip(`<strong>Total:</strong> ${v}<br/><strong>County:</strong> ${fipsToCounty[Number(f)] || 'Unknown County'}`);
            this.markerClusters.addLayer(marker);
        });

        // Keep choropleth on top
        this.countiesLayer.bringToFront();
    }

    public destroy(): void { this.map?.remove(); }

    private resizeMap(opts: VisualUpdateOptions): void {
        requestAnimationFrame(() => {
            this.mapContainer.style.width = `${opts.viewport.width}px`;
            this.mapContainer.style.height = `${opts.viewport.height}px`;
            this.map.invalidateSize();
        });
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
        this.map = L.map("mapid", { preferCanvas: true })
            .setView([35.54, -79.24], 7);
            
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: '© OpenStreetMap contributors'
        }).addTo(this.map);
    }

}
