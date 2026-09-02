import type { Metadata } from "next";
import { Michroma, Chakra_Petch } from "next/font/google";
import "./globals.css";

// Michroma — squared, extended Eurostile-style lettering (the J.A.R.V.I.S.
// logo face). Display slots only: clock, big numerals, section titles.
const display = Michroma({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
});

// Chakra Petch carries the dense micro-text. Michroma is a headline face —
// at the 7-10px the panels run at, its uniform stroke and closed apertures
// turn to mush. This keeps the squared techy feel but stays readable small.
const mono = Chakra_Petch({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "A.I.",
  description: "Voice-driven heads-up display over your own file-backed agent",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
