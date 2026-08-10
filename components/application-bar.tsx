"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from "react";

type ApplicationBarProps = {
  children: ReactNode;
};

type ApplicationMenuProps = {
  children: (closeMenu: () => void) => ReactNode;
  label: string;
};

type ApplicationMenuGroupProps = {
  children: ReactNode;
  label: string;
};

type ApplicationMenuItemProps = {
  busy?: boolean;
  children: ReactNode;
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
  closeMenu: () => void;
};

export function ApplicationBar({ children }: ApplicationBarProps) {
  return (
    <header className="application-bar">
      <h1 className="application-identity">Patchmark</h1>
      <nav className="application-bar-actions" aria-label="Application actions">
        {children}
      </nav>
    </header>
  );
}

export function ApplicationMenu({ children, label }: ApplicationMenuProps) {
  const menuId = useId();
  const triggerId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openingPositionRef = useRef<"first" | "last">("first");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>(
          '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])'
        ) ?? []
      );
      items[
        openingPositionRef.current === "first" ? 0 : items.length - 1
      ]?.focus();
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [open]);

  function getEnabledItems() {
    return Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])'
      ) ?? []
    );
  }

  function openMenu(position: "first" | "last" = "first") {
    openingPositionRef.current = position;
    setOpen(true);
  }

  function closeMenu() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) {
        closeMenu();
      } else {
        openMenu();
      }
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openMenu(event.key === "ArrowUp" ? "last" : "first");
    }
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }

    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }

    event.preventDefault();
    const items = getEnabledItems();
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex = currentIndex;

    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    } else if (event.key === "ArrowDown") {
      nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
    } else {
      nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
    }

    items[nextIndex]?.focus();
  }

  return (
    <div className="application-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        className="application-menu-trigger"
        id={triggerId}
        type="button"
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        {label}
      </button>
      <div
        ref={menuRef}
        className="application-menu-panel"
        id={menuId}
        role="menu"
        aria-labelledby={triggerId}
        hidden={!open}
        onKeyDown={handleMenuKeyDown}
      >
        {children(closeMenu)}
      </div>
    </div>
  );
}

export function ApplicationMenuGroup({
  children,
  label
}: ApplicationMenuGroupProps) {
  const labelId = useId();

  return (
    <div className="application-menu-group" role="group" aria-labelledby={labelId}>
      <span className="application-menu-group-label" id={labelId}>
        {label}
      </span>
      {children}
    </div>
  );
}

export function ApplicationMenuItem({
  busy = false,
  children,
  closeMenu,
  disabled = false,
  onSelect
}: ApplicationMenuItemProps) {
  return (
    <button
      className="application-menu-item"
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={() => {
        void onSelect();
        closeMenu();
      }}
    >
      {children}
    </button>
  );
}
