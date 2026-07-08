import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BuildLab — Learn by Building",
  description:
    "An AI tutor that teaches science and engineering by building 3D models with you.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
