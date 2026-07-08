import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        "lab-bg": "#0a0a12",
        "lab-panel": "#12121c",
        "lab-border": "#242438",
        "lab-accent": "#6366f1",
      },
    },
  },
  plugins: [],
};

export default config;
