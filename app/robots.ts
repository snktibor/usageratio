import type { MetadataRoute } from "next";

// A private dashboard: keep every crawler out.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
