import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { createTV } from "tailwind-variants";

const twMergeConfig = {
  extend: {
    classGroups: {
      // Thalia's Apple type scale, so text-footnote + text-label merge cleanly.
      "font-size": [
        "text-large-title",
        "text-title-1",
        "text-title-2",
        "text-title-3",
        "text-headline",
        "text-body",
        "text-callout",
        "text-subheadline",
        "text-footnote",
        "text-caption-1",
        "text-caption-2",
      ],
    },
  },
} as const;

const twMerge = extendTailwindMerge(twMergeConfig);

/** `tailwind-variants` factory wired to Thalia's type scale. */
export const tv = createTV({ twMerge: true, twMergeConfig });

/** Merges class lists; Tailwind classes and Thalia's type scale dedupe by role. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** A props type without `child`. */
export type WithoutChild<T> = T extends { child?: unknown }
  ? Omit<T, "child">
  : T;
/** A props type without `children`. */
export type WithoutChildren<T> = T extends { children?: unknown }
  ? Omit<T, "children">
  : T;
/** A props type without `children` or `child`. */
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
/** Element props plus a bindable `ref`. */
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & {
  ref?: U | null;
};
