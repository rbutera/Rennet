"use client"

import * as React from "react"
import { useAppStore } from "@/lib/store"

/**
 * Applies the store's appearance state to <html>: data-scheme + the .dark class
 * (Tailwind's dark: variant and the palette both key on .dark) for the scheme,
 * and data-rn-theme for the UI theme pack ("affineur" clears it → base palette).
 * "system" resolves via matchMedia and re-applies on OS scheme change. Renders
 * nothing. No persist — throwaway prototype state (#480).
 */
export function AppearanceSync() {
  const scheme = useAppStore((s) => s.scheme)
  const themePack = useAppStore((s) => s.themePack)

  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const apply = () => {
      const resolved = scheme === "system" ? (mq.matches ? "dark" : "light") : scheme
      const html = document.documentElement
      html.dataset.scheme = resolved
      html.classList.toggle("dark", resolved === "dark")
      if (themePack === "affineur") delete html.dataset.rnTheme
      else html.dataset.rnTheme = themePack
      useAppStore.getState().setResolvedScheme(resolved)
    }
    apply()
    if (scheme === "system") {
      mq.addEventListener("change", apply)
      return () => mq.removeEventListener("change", apply)
    }
  }, [scheme, themePack])

  return null
}
