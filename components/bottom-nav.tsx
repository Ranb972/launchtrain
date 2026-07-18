"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

// Mobile bottom nav (SPEC §8): Board / My Tests / My Requests / Profile.
// Rendered for authenticated users only (see Header). "Profile" maps to
// /settings until the public /profile/[id] page lands with F6 (approved
// interim mapping, SPEC v1.7). My Tests / My Requests are the two dashboard
// sections — anchors scroll to them on the stacked mobile layout.

const ICON_PROPS = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function BoardIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 21V9" />
    </svg>
  );
}

function TestsIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <rect x="5" y="2" width="14" height="20" rx="2" />
      <path d="M12 18h.01" />
    </svg>
  );
}

function RequestsIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a7 7 0 0 1 14 0v1" />
    </svg>
  );
}

export function BottomNav() {
  const pathname = usePathname();
  const [hash, setHash] = useState("");

  useEffect(() => {
    const update = () => setHash(window.location.hash);
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, [pathname]);

  const items = [
    {
      label: "Board",
      href: "/board",
      icon: <BoardIcon />,
      active: pathname === "/board",
    },
    {
      label: "My Tests",
      href: "/dashboard#my-tests",
      icon: <TestsIcon />,
      active: pathname === "/dashboard" && hash !== "#my-requests",
    },
    {
      label: "My Requests",
      href: "/dashboard#my-requests",
      icon: <RequestsIcon />,
      active: pathname === "/dashboard" && hash === "#my-requests",
    },
    {
      label: "Profile",
      href: "/settings",
      icon: <ProfileIcon />,
      active: pathname === "/settings",
    },
  ];

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-800 bg-zinc-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
    >
      <div className="mx-auto flex max-w-5xl">
        {items.map((item) => (
          <Link
            key={item.label}
            href={item.href}
            className={`flex flex-1 flex-col items-center gap-1 py-2 text-[11px] font-medium transition-colors ${
              item.active
                ? "text-emerald-400"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {item.icon}
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
