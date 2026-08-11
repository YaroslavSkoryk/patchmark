"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

type ActionMenuProps = {
  children: (closeMenu: () => void) => ReactNode;
  label: string;
  panelClassName?: string;
  rootClassName?: string;
  triggerChildren: ReactNode;
  triggerClassName?: string;
};

type ActionMenuGroupProps = {
  children: ReactNode;
  className?: string;
  label: string;
  labelClassName?: string;
};

type ActionMenuItemProps = {
  busy?: boolean;
  children: ReactNode;
  className?: string;
  closeMenu: () => void;
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
};

type MenuPosition = {
  left: number;
  top: number;
  width?: number;
};

export function ActionMenu({
  children,
  label,
  panelClassName,
  rootClassName,
  triggerChildren,
  triggerClassName
}: ActionMenuProps) {
  const menuId = useId();
  const triggerId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openingPositionRef = useRef<"first" | "last">("first");
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleOutsidePointer(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
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

    let focusFrame = 0;
    function focusMenu(attempt: number) {
      focusFrame = window.requestAnimationFrame(() => {
        const items = getEnabledItems(menuRef.current);
        const target = items[
          openingPositionRef.current === "first" ? 0 : items.length - 1
        ];
        if (target) {
          target.focus();
        } else if (attempt < 10) {
          focusMenu(attempt + 1);
        }
      });
    }
    focusMenu(0);

    return () => {
      window.cancelAnimationFrame(focusFrame);
    };
  }, [mounted, open]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    function placeMenu() {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) {
        return;
      }

      const rootStyle = window.getComputedStyle(document.documentElement);
      const defaultViewportPadding = window.innerWidth <= 520 ? 20 : 12;
      const viewportPadding = {
        bottom: Math.max(
          defaultViewportPadding,
          parseCssPixelValue(rootStyle.getPropertyValue("--safe-area-bottom"))
        ),
        left: Math.max(
          defaultViewportPadding,
          parseCssPixelValue(rootStyle.getPropertyValue("--safe-area-left"))
        ),
        right: Math.max(
          defaultViewportPadding,
          parseCssPixelValue(rootStyle.getPropertyValue("--safe-area-right"))
        ),
        top: Math.max(
          defaultViewportPadding,
          parseCssPixelValue(rootStyle.getPropertyValue("--safe-area-top"))
        )
      };
      const triggerRect = trigger.getBoundingClientRect();
      const fullWidth = window.innerWidth <= 520 &&
        panelClassName?.includes("application-menu-panel");
      const width = fullWidth
        ? window.innerWidth - viewportPadding.left - viewportPadding.right
        : menu.offsetWidth;
      const left = fullWidth
        ? viewportPadding.left
        : Math.max(
            viewportPadding.left,
            Math.min(
              triggerRect.right - width,
              window.innerWidth - width - viewportPadding.right
            )
          );
      const top =
        triggerRect.bottom + menu.offsetHeight + 6 >
        window.innerHeight - viewportPadding.bottom
          ? Math.max(
              viewportPadding.top,
              triggerRect.top - menu.offsetHeight - 6
            )
          : triggerRect.bottom + 6;
      setPosition({ left, top, ...(fullWidth ? { width } : {}) });
    }

    placeMenu();
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  }, [open, panelClassName]);

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
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      const trigger = triggerRef.current;
      const focusScope =
        trigger?.closest<HTMLElement>('[role="dialog"]') ?? document.body;
      const candidates = Array.from(
        focusScope.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
        )
      ).filter(
        (candidate) =>
          candidate.getClientRects().length > 0 &&
          !menuRef.current?.contains(candidate)
      );
      const triggerIndex = trigger ? candidates.indexOf(trigger) : -1;
      const nextIndex = event.shiftKey
        ? triggerIndex > 0
          ? triggerIndex - 1
          : candidates.length - 1
        : triggerIndex >= 0 && triggerIndex < candidates.length - 1
          ? triggerIndex + 1
          : 0;
      setOpen(false);
      window.requestAnimationFrame(() => candidates[nextIndex]?.focus());
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      return;
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      return;
    }

    event.preventDefault();
    const items = getEnabledItems(menuRef.current);
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

  const panelStyle: CSSProperties = position
    ? {
        left: position.left,
        top: position.top,
        ...(position.width ? { width: position.width } : {})
      }
    : { left: 0, top: 0, visibility: "hidden" };

  return (
    <div className={rootClassName} ref={rootRef}>
      <button
        ref={triggerRef}
        className={triggerClassName}
        id={triggerId}
        type="button"
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        {triggerChildren}
      </button>
      {mounted
        ? createPortal(
            <div
              ref={menuRef}
              className={panelClassName}
              id={menuId}
              role="menu"
              aria-labelledby={triggerId}
              hidden={!open}
              style={panelStyle}
              onKeyDown={handleMenuKeyDown}
            >
              {children(closeMenu)}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

export function ActionMenuGroup({
  children,
  className,
  label,
  labelClassName
}: ActionMenuGroupProps) {
  const labelId = useId();

  return (
    <div className={className} role="group" aria-labelledby={labelId}>
      <span className={labelClassName} id={labelId}>
        {label}
      </span>
      {children}
    </div>
  );
}

export function ActionMenuItem({
  busy = false,
  children,
  className,
  closeMenu,
  disabled = false,
  onSelect
}: ActionMenuItemProps) {
  return (
    <button
      className={className}
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

function getEnabledItems(menu: HTMLDivElement | null): HTMLElement[] {
  return Array.from(
    menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []
  ).filter(
    (item) =>
      !(item instanceof HTMLButtonElement && item.disabled) &&
      item.getAttribute("aria-disabled") !== "true"
  );
}

function parseCssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
