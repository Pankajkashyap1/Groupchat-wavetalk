import "./globals.css";

export const metadata = {
  title: "WaveTalk",
  description: "Real-time group chat over WebSockets",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}