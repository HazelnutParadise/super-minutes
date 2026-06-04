import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "2rem", screens: { "2xl": "1400px" } },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // Editorial palette — direct access, used in components.
        ink: {
          DEFAULT: "#111014",
          900: "#0A090C",
          800: "#16151A",
          700: "#1E1D23",
          600: "#2B2A32",
        },
        cream: {
          DEFAULT: "#F3ECDC",
          50: "#FAF6EC",
          100: "#F3ECDC",
          200: "#E8DEC4",
          300: "#D2C49E",
          400: "#A89B79",
          500: "#6F664F",
        },
        vermillion: {
          DEFAULT: "#D43F3F",
          400: "#E45757",
          500: "#D43F3F",
          600: "#A82E2E",
        },
        jade: {
          DEFAULT: "#6FA688",
          400: "#85BA9D",
          500: "#6FA688",
          600: "#54866C",
        },
      },
      fontFamily: {
        display: ["'Instrument Serif'", "Georgia", "serif"],
        sans: [
          "'Geist'",
          "'Inter'",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
        mono: ["'JetBrains Mono'", "'IBM Plex Mono'", "monospace"],
        han: ["'Noto Serif TC'", "'Source Han Serif TC'", "serif"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "ledger-rise": {
          "0%": { transform: "translateY(18px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        "stamp-in": {
          "0%": { transform: "rotate(-8deg) scale(1.4)", opacity: "0" },
          "70%": { transform: "rotate(-3deg) scale(0.95)", opacity: "1" },
          "100%": { transform: "rotate(-2deg) scale(1)", opacity: "1" },
        },
        "type-blink": {
          "0%, 50%": { opacity: "1" },
          "51%, 100%": { opacity: "0" },
        },
        "tape-slide": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        "char-reveal": {
          "0%": { transform: "translateY(0.5em)", opacity: "0", filter: "blur(4px)" },
          "100%": { transform: "translateY(0)", opacity: "1", filter: "blur(0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "ledger-rise": "ledger-rise 700ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "stamp-in": "stamp-in 600ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "type-blink": "type-blink 1s steps(1) infinite",
        "tape-slide": "tape-slide 9s linear infinite",
        "char-reveal": "char-reveal 700ms cubic-bezier(0.22, 1, 0.36, 1) both",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
