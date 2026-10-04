import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest { return { name: "ParkShare", short_name: "ParkShare", display: "standalone", theme_color: "#0f766e", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }] }; }
