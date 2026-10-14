import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <span aria-hidden="true" className="text-fd-primary">
            [m]
          </span>
          <span>migrate-sdk</span>
        </>
      ),
      url: "/",
    },
    githubUrl: "https://github.com/asgorobets/migrate-sdk",
    links: [{ text: "Home", url: "/", active: "url" }],
  };
}
