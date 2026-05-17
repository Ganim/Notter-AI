/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    './index.html',
    './src/**/*.{ts,tsx,js,jsx}',
  ],
  // TagChip palette classes are built dynamically via array lookup in
  // src/components/sidebar/TagChip.tsx and would be purged without this list.
  safelist: [
    'bg-rose-500/15', 'text-rose-700', 'dark:text-rose-300', 'ring-rose-500/30',
    'bg-amber-500/15', 'text-amber-700', 'dark:text-amber-300', 'ring-amber-500/30',
    'bg-emerald-500/15', 'text-emerald-700', 'dark:text-emerald-300', 'ring-emerald-500/30',
    'bg-sky-500/15', 'text-sky-700', 'dark:text-sky-300', 'ring-sky-500/30',
    'bg-violet-500/15', 'text-violet-700', 'dark:text-violet-300', 'ring-violet-500/30',
    'bg-fuchsia-500/15', 'text-fuchsia-700', 'dark:text-fuchsia-300', 'ring-fuchsia-500/30',
    'bg-teal-500/15', 'text-teal-700', 'dark:text-teal-300', 'ring-teal-500/30',
    'bg-orange-500/15', 'text-orange-700', 'dark:text-orange-300', 'ring-orange-500/30',
  ],
  theme: {
    extend: {
      colors: {
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        background: "var(--background)",
        foreground: "var(--foreground)",
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/typography")],
}
