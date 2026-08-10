import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard" },
      { name: "description", content: "Blank dashboard page with sidebar navigation." },
      { property: "og:title", content: "Dashboard" },
      { property: "og:description", content: "Blank dashboard page with sidebar navigation." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <div className="flex min-h-[calc(100svh-3rem)] items-center justify-center">
      <p className="text-sm text-muted-foreground">Blank page</p>
    </div>
  );
}
