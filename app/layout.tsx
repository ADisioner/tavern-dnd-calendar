import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Таверна · Календарь приключений",
  description: "Найдите время для D&D: свободные окна всей группы, автоматический подбор сессий и локальное время каждого игрока.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body className="antialiased">{children}</body>
    </html>
  );
}
