/// <reference types="vite/client" />
import type { ReactNode } from "react";
import * as tsr from "@tanstack/react-router";
import globalStyles from "@/styles/global.css?url";

export const Route = tsr.createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Agent Sessions · CodeOps" },
      {
        name: "description",
        content: "Live and archived CodeOps agent sessions.",
      },
    ],
    links: [
      { rel: "stylesheet", href: globalStyles },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "icon", href: "/codeops-session-icon.svg", type: "image/svg+xml" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <tsr.Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <tsr.HeadContent />
      </head>
      <body>{children}<tsr.Scripts /></body>
    </html>
  );
}
