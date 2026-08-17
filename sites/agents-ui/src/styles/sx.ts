import * as stylex from "@stylexjs/stylex";

type SxValue = string | false | null | undefined;

const utilityStyles = stylex.create({
  "-mx-4": {
    "marginLeft": -16,
    "marginRight": -16
  },
  "-translate-y-1/2": {
    "transform": "translateY(-50%)"
  },
  "absolute": {
    "position": "absolute"
  },
  "accent-[#7774ff]": {
    "accentColor": "rgb(119 116 255)"
  },
  "backdrop-blur-[2px]": {
    "backdropFilter": "blur(2px)"
  },
  "backdrop-blur-xl": {
    "backdropFilter": "blur(24px)"
  },
  "bg-[#111113]": {
    "backgroundColor": "rgb(17 17 19)"
  },
  "bg-[#131315]": {
    "backgroundColor": "rgb(19 19 21)"
  },
  "bg-[#151517]": {
    "backgroundColor": "rgb(21 21 23)"
  },
  "bg-[#151517]/94": {
    "backgroundColor": "rgb(21 21 23 / 0.94)"
  },
  "bg-[#151517]/95": {
    "backgroundColor": "rgb(21 21 23 / 0.95)"
  },
  "bg-[#171719]": {
    "backgroundColor": "rgb(23 23 25)"
  },
  "bg-[#1a1a1d]": {
    "backgroundColor": "rgb(26 26 29)"
  },
  "bg-[#54d18b]": {
    "backgroundColor": "rgb(84 209 139)"
  },
  "bg-[#54d18b]/6": {
    "backgroundColor": "rgb(84 209 139 / 0.06)"
  },
  "bg-[#54d18b]/7": {
    "backgroundColor": "rgb(84 209 139 / 0.07)"
  },
  "bg-[#54d18b]/8": {
    "backgroundColor": "rgb(84 209 139 / 0.08)"
  },
  "bg-[#6d6af7]": {
    "backgroundColor": "rgb(109 106 247)"
  },
  "bg-[#6da8ff]": {
    "backgroundColor": "rgb(109 168 255)"
  },
  "bg-[#6da8ff]/10": {
    "backgroundColor": "rgb(109 168 255 / 0.1)"
  },
  "bg-[#6da8ff]/6": {
    "backgroundColor": "rgb(109 168 255 / 0.06)"
  },
  "bg-[#6da8ff]/7": {
    "backgroundColor": "rgb(109 168 255 / 0.07)"
  },
  "bg-[#6da8ff]/8": {
    "backgroundColor": "rgb(109 168 255 / 0.08)"
  },
  "bg-[#7774ff]/10": {
    "backgroundColor": "rgb(119 116 255 / 0.1)"
  },
  "bg-[#7774ff]/55": {
    "backgroundColor": "rgb(119 116 255 / 0.55)"
  },
  "bg-[#7774ff]/7": {
    "backgroundColor": "rgb(119 116 255 / 0.07)"
  },
  "bg-[#7774ff]/[0.055]": {
    "backgroundColor": "rgb(119 116 255 / 0.055)"
  },
  "bg-[#8c89ff]": {
    "backgroundColor": "rgb(140 137 255)"
  },
  "bg-[#8e8bff]": {
    "backgroundColor": "rgb(142 139 255)"
  },
  "bg-[#b39cff]/6": {
    "backgroundColor": "rgb(179 156 255 / 0.06)"
  },
  "bg-[#ff7278]/10": {
    "backgroundColor": "rgb(255 114 120 / 0.1)"
  },
  "bg-[#ff7278]/[0.045]": {
    "backgroundColor": "rgb(255 114 120 / 0.045)"
  },
  "bg-[#ff747b]/14": {
    "backgroundColor": "rgb(255 116 123 / 0.14)"
  },
  "bg-[#ff747b]/7": {
    "backgroundColor": "rgb(255 116 123 / 0.07)"
  },
  "bg-[#ff747b]/8": {
    "backgroundColor": "rgb(255 116 123 / 0.08)"
  },
  "bg-[#ff9b73]": {
    "backgroundColor": "rgb(255 155 115)"
  },
  "bg-[#ff9b73]/10": {
    "backgroundColor": "rgb(255 155 115 / 0.1)"
  },
  "bg-[#ff9b73]/8": {
    "backgroundColor": "rgb(255 155 115 / 0.08)"
  },
  "bg-[#ff9b73]/[0.055]": {
    "backgroundColor": "rgb(255 155 115 / 0.055)"
  },
  "bg-black/10": {
    "backgroundColor": "rgb(0 0 0 / 0.1)"
  },
  "bg-black/15": {
    "backgroundColor": "rgb(0 0 0 / 0.15)"
  },
  "bg-black/20": {
    "backgroundColor": "rgb(0 0 0 / 0.2)"
  },
  "bg-black/25": {
    "backgroundColor": "rgb(0 0 0 / 0.25)"
  },
  "bg-black/55": {
    "backgroundColor": "rgb(0 0 0 / 0.55)"
  },
  "bg-current": {
    "backgroundColor": "currentColor"
  },
  "bg-transparent": {
    "backgroundColor": "transparent"
  },
  "bg-white/15": {
    "backgroundColor": "rgb(255 255 255 / 0.15)"
  },
  "bg-white/20": {
    "backgroundColor": "rgb(255 255 255 / 0.2)"
  },
  "bg-white/22": {
    "backgroundColor": "rgb(255 255 255 / 0.22)"
  },
  "bg-white/[0.025]": {
    "backgroundColor": "rgb(255 255 255 / 0.025)"
  },
  "bg-white/[0.02]": {
    "backgroundColor": "rgb(255 255 255 / 0.02)"
  },
  "bg-white/[0.035]": {
    "backgroundColor": "rgb(255 255 255 / 0.035)"
  },
  "bg-white/[0.05]": {
    "backgroundColor": "rgb(255 255 255 / 0.05)"
  },
  "bg-white/[0.075]": {
    "backgroundColor": "rgb(255 255 255 / 0.075)"
  },
  "bg-white/[0.07]": {
    "backgroundColor": "rgb(255 255 255 / 0.07)"
  },
  "bg-white/[0.09]": {
    "backgroundColor": "rgb(255 255 255 / 0.09)"
  },
  "block": {
    "display": "block"
  },
  "border": {
    "borderWidth": 1,
    "borderStyle": "solid"
  },
  "border-[#54d18b]/12": {
    "borderColor": "rgb(84 209 139 / 0.12)"
  },
  "border-[#54d18b]/15": {
    "borderColor": "rgb(84 209 139 / 0.15)"
  },
  "border-[#54d18b]/18": {
    "borderColor": "rgb(84 209 139 / 0.18)"
  },
  "border-[#6da8ff]/12": {
    "borderColor": "rgb(109 168 255 / 0.12)"
  },
  "border-[#6da8ff]/15": {
    "borderColor": "rgb(109 168 255 / 0.15)"
  },
  "border-[#6da8ff]/16": {
    "borderColor": "rgb(109 168 255 / 0.16)"
  },
  "border-[#6da8ff]/18": {
    "borderColor": "rgb(109 168 255 / 0.18)"
  },
  "border-[#7774ff]/10": {
    "borderColor": "rgb(119 116 255 / 0.1)"
  },
  "border-[#7774ff]/12": {
    "borderColor": "rgb(119 116 255 / 0.12)"
  },
  "border-[#7774ff]/18": {
    "borderColor": "rgb(119 116 255 / 0.18)"
  },
  "border-[#7774ff]/25": {
    "borderColor": "rgb(119 116 255 / 0.25)"
  },
  "border-[#7774ff]/45": {
    "borderColor": "rgb(119 116 255 / 0.45)"
  },
  "border-[#8c89ff]": {
    "borderColor": "rgb(140 137 255)"
  },
  "border-[#b39cff]/12": {
    "borderColor": "rgb(179 156 255 / 0.12)"
  },
  "border-[#ff7278]/18": {
    "borderColor": "rgb(255 114 120 / 0.18)"
  },
  "border-[#ff747b]/13": {
    "borderColor": "rgb(255 116 123 / 0.13)"
  },
  "border-[#ff747b]/16": {
    "borderColor": "rgb(255 116 123 / 0.16)"
  },
  "border-[#ff747b]/22": {
    "borderColor": "rgb(255 116 123 / 0.22)"
  },
  "border-[#ff9b73]/12": {
    "borderColor": "rgb(255 155 115 / 0.12)"
  },
  "border-[#ff9b73]/18": {
    "borderColor": "rgb(255 155 115 / 0.18)"
  },
  "border-[#ff9b73]/20": {
    "borderColor": "rgb(255 155 115 / 0.2)"
  },
  "border-[#ff9b73]/22": {
    "borderColor": "rgb(255 155 115 / 0.22)"
  },
  "border-[#ff9b73]/25": {
    "borderColor": "rgb(255 155 115 / 0.25)"
  },
  "border-b": {
    "borderBottomWidth": 1,
    "borderStyle": "solid"
  },
  "border-dashed": {
    "borderStyle": "dashed"
  },
  "border-l": {
    "borderLeftWidth": 1,
    "borderStyle": "solid"
  },
  "border-r": {
    "borderRightWidth": 1,
    "borderStyle": "solid"
  },
  "border-t": {
    "borderTopWidth": 1,
    "borderStyle": "solid"
  },
  "border-white/20": {
    "borderColor": "rgb(255 255 255 / 0.2)"
  },
  "border-white/[0.045]": {
    "borderColor": "rgb(255 255 255 / 0.045)"
  },
  "border-white/[0.04]": {
    "borderColor": "rgb(255 255 255 / 0.04)"
  },
  "border-white/[0.055]": {
    "borderColor": "rgb(255 255 255 / 0.055)"
  },
  "border-white/[0.05]": {
    "borderColor": "rgb(255 255 255 / 0.05)"
  },
  "border-white/[0.065]": {
    "borderColor": "rgb(255 255 255 / 0.065)"
  },
  "border-white/[0.06]": {
    "borderColor": "rgb(255 255 255 / 0.06)"
  },
  "border-white/[0.07]": {
    "borderColor": "rgb(255 255 255 / 0.07)"
  },
  "border-white/[0.08]": {
    "borderColor": "rgb(255 255 255 / 0.08)"
  },
  "border-white/[0.09]": {
    "borderColor": "rgb(255 255 255 / 0.09)"
  },
  "border-white/[0.11]": {
    "borderColor": "rgb(255 255 255 / 0.11)"
  },
  "border-white/[0.1]": {
    "borderColor": "rgb(255 255 255 / 0.1)"
  },
  "bottom-0": {
    "bottom": 0
  },
  "bottom-3": {
    "bottom": 12
  },
  "break-words": {
    "overflowWrap": "break-word"
  },
  "capitalize": {
    "textTransform": "capitalize"
  },
  "cursor-not-allowed": {
    "cursor": "not-allowed"
  },
  "cursor-pointer": {
    "cursor": "pointer"
  },
  "decoration-[#9cc3ff]/25": {
    "textDecorationColor": "rgb(156 195 255 / 0.25)"
  },
  "disabled:bg-white/[0.06]": {
    ":disabled": {
      "backgroundColor": "rgb(255 255 255 / 0.06)"
    }
  },
  "disabled:cursor-not-allowed": {
    ":disabled": {
      "cursor": "not-allowed"
    }
  },
  "disabled:opacity-35": {
    ":disabled": {
      "opacity": 0.35
    }
  },
  "disabled:opacity-40": {
    ":disabled": {
      "opacity": 0.4
    }
  },
  "disabled:opacity-45": {
    ":disabled": {
      "opacity": 0.45
    }
  },
  "disabled:opacity-55": {
    ":disabled": {
      "opacity": 0.55
    }
  },
  "disabled:text-white/18": {
    ":disabled": {
      "color": "rgb(255 255 255 / 0.18)"
    }
  },
  "first:mt-1": {
    ":first-child": {
      "marginTop": 4
    }
  },
  "fixed": {
    "position": "fixed"
  },
  "flex": {
    "display": "flex"
  },
  "flex-1": {
    "flex": "1 1 0%"
  },
  "flex-col": {
    "flexDirection": "column"
  },
  "flex-wrap": {
    "flexWrap": "wrap"
  },
  "float-right": {
    "float": "right"
  },
  "focus-within:border-[#7774ff]/45": {
    ":focus-within": {
      "borderColor": "rgb(119 116 255 / 0.45)"
    }
  },
  "focus-within:ring-2": {
    ":focus-within": {
      "outlineStyle": "solid",
      "outlineWidth": 2
    }
  },
  "focus-within:ring-[#7774ff]/10": {
    ":focus-within": {
      "outlineColor": "rgb(119 116 255 / 0.1)"
    }
  },
  "focus:bg-white/[0.05]": {
    ":focus": {
      "backgroundColor": "rgb(255 255 255 / 0.05)"
    }
  },
  "focus:border-[#7774ff]/45": {
    ":focus": {
      "borderColor": "rgb(119 116 255 / 0.45)"
    }
  },
  "focus:border-[#7774ff]/50": {
    ":focus": {
      "borderColor": "rgb(119 116 255 / 0.5)"
    }
  },
  "focus:border-[#7774ff]/55": {
    ":focus": {
      "borderColor": "rgb(119 116 255 / 0.55)"
    }
  },
  "focus:ring-2": {
    ":focus": {
      "outlineStyle": "solid",
      "outlineWidth": 2
    }
  },
  "focus:ring-[#7774ff]/10": {
    ":focus": {
      "outlineColor": "rgb(119 116 255 / 0.1)"
    }
  },
  "font-bold": {
    "fontWeight": 700
  },
  "font-medium": {
    "fontWeight": 500
  },
  "font-mono": {
    "fontFamily": "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
  },
  "font-normal": {
    "fontWeight": 400
  },
  "font-sans": {
    "fontFamily": "Inter, ui-sans-serif, system-ui, sans-serif"
  },
  "font-semibold": {
    "fontWeight": 600
  },
  "gap-1": {
    "gap": 4
  },
  "gap-1.5": {
    "gap": 6
  },
  "gap-2": {
    "gap": 8
  },
  "gap-2.5": {
    "gap": 10
  },
  "gap-3": {
    "gap": 12
  },
  "gap-4": {
    "gap": 16
  },
  "gap-5": {
    "gap": 20
  },
  "gap-8": {
    "gap": 32
  },
  "gap-x-2": {
    "columnGap": 8
  },
  "gap-y-1": {
    "rowGap": 4
  },
  "grid": {
    "display": "grid"
  },
  "grid-cols-3": {
    "gridTemplateColumns": "repeat(3, minmax(0, 1fr))"
  },
  "grid-cols-[16px_minmax(0,1fr)]": {
    "gridTemplateColumns": "16px minmax(0,1fr)"
  },
  "grid-cols-[28px_minmax(0,1fr)]": {
    "gridTemplateColumns": "28px minmax(0,1fr)"
  },
  "grid-cols-[minmax(0,1fr)_auto_auto]": {
    "gridTemplateColumns": "minmax(0,1fr) auto auto"
  },
  "h-10": {
    "height": 40
  },
  "h-11": {
    "height": 44
  },
  "h-13": {
    "height": 52
  },
  "h-8": {
    "height": 32
  },
  "h-dvh": {
    "height": "100dvh"
  },
  "hidden": {
    "display": "none"
  },
  "hover:bg-[#7774ff]/18": {
    ":hover": {
      "backgroundColor": "rgb(119 116 255 / 0.18)"
    }
  },
  "hover:bg-[#7774ff]/[0.05]": {
    ":hover": {
      "backgroundColor": "rgb(119 116 255 / 0.05)"
    }
  },
  "hover:bg-[#7c79ff]": {
    ":hover": {
      "backgroundColor": "rgb(124 121 255)"
    }
  },
  "hover:bg-[#ff747b]/20": {
    ":hover": {
      "backgroundColor": "rgb(255 116 123 / 0.2)"
    }
  },
  "hover:bg-[#ff747b]/8": {
    ":hover": {
      "backgroundColor": "rgb(255 116 123 / 0.08)"
    }
  },
  "hover:bg-[#ff9b73]/14": {
    ":hover": {
      "backgroundColor": "rgb(255 155 115 / 0.14)"
    }
  },
  "hover:bg-[#ff9b73]/16": {
    ":hover": {
      "backgroundColor": "rgb(255 155 115 / 0.16)"
    }
  },
  "hover:bg-white/[0.025]": {
    ":hover": {
      "backgroundColor": "rgb(255 255 255 / 0.025)"
    }
  },
  "hover:bg-white/[0.035]": {
    ":hover": {
      "backgroundColor": "rgb(255 255 255 / 0.035)"
    }
  },
  "hover:bg-white/[0.045]": {
    ":hover": {
      "backgroundColor": "rgb(255 255 255 / 0.045)"
    }
  },
  "hover:bg-white/[0.04]": {
    ":hover": {
      "backgroundColor": "rgb(255 255 255 / 0.04)"
    }
  },
  "hover:bg-white/[0.055]": {
    ":hover": {
      "backgroundColor": "rgb(255 255 255 / 0.055)"
    }
  },
  "hover:bg-white/[0.05]": {
    ":hover": {
      "backgroundColor": "rgb(255 255 255 / 0.05)"
    }
  },
  "hover:bg-white/[0.1]": {
    ":hover": {
      "backgroundColor": "rgb(255 255 255 / 0.1)"
    }
  },
  "hover:border-[#7774ff]/35": {
    ":hover": {
      "borderColor": "rgb(119 116 255 / 0.35)"
    }
  },
  "hover:border-white/[0.13]": {
    ":hover": {
      "borderColor": "rgb(255 255 255 / 0.13)"
    }
  },
  "hover:text-[#bdd7ff]": {
    ":hover": {
      "fontSize": "#bdd7ff"
    }
  },
  "hover:text-[#ff989d]": {
    ":hover": {
      "fontSize": "#ff989d"
    }
  },
  "hover:text-white": {
    ":hover": {
      "color": "rgb(255 255 255)"
    }
  },
  "hover:text-white/60": {
    ":hover": {
      "color": "rgb(255 255 255 / 0.6)"
    }
  },
  "hover:text-white/65": {
    ":hover": {
      "color": "rgb(255 255 255 / 0.65)"
    }
  },
  "hover:text-white/68": {
    ":hover": {
      "color": "rgb(255 255 255 / 0.68)"
    }
  },
  "hover:text-white/70": {
    ":hover": {
      "color": "rgb(255 255 255 / 0.7)"
    }
  },
  "hover:text-white/72": {
    ":hover": {
      "color": "rgb(255 255 255 / 0.72)"
    }
  },
  "hover:text-white/75": {
    ":hover": {
      "color": "rgb(255 255 255 / 0.75)"
    }
  },
  "hover:text-white/78": {
    ":hover": {
      "color": "rgb(255 255 255 / 0.78)"
    }
  },
  "hover:text-white/88": {
    ":hover": {
      "color": "rgb(255 255 255 / 0.88)"
    }
  },
  "inline-flex": {
    "display": "inline-flex"
  },
  "inline-grid": {
    "display": "inline-grid"
  },
  "inset-0": {
    "inset": 0
  },
  "items-baseline": {
    "alignItems": "baseline"
  },
  "items-center": {
    "alignItems": "center"
  },
  "items-end": {
    "alignItems": "flex-end"
  },
  "items-start": {
    "alignItems": "flex-start"
  },
  "justify-between": {
    "justifyContent": "space-between"
  },
  "justify-center": {
    "justifyContent": "center"
  },
  "justify-end": {
    "justifyContent": "flex-end"
  },
  "leading-3": {
    "lineHeight": 12
  },
  "leading-4": {
    "lineHeight": 16
  },
  "leading-5": {
    "lineHeight": 20
  },
  "leading-6": {
    "lineHeight": 24
  },
  "left-2.5": {
    "left": 10
  },
  "left-3": {
    "left": 12
  },
  "lg:block": {
    "@media (min-width: 1024px)": {
      "display": "block"
    }
  },
  "lg:bottom-3": {
    "@media (min-width: 1024px)": {
      "bottom": 12
    }
  },
  "lg:flex": {
    "@media (min-width: 1024px)": {
      "display": "flex"
    }
  },
  "lg:grid": {
    "@media (min-width: 1024px)": {
      "display": "grid"
    }
  },
  "lg:grid-cols-[304px_minmax(0,1fr)]": {
    "@media (min-width: 1024px)": {
      "gridTemplateColumns": "304px minmax(0,1fr)"
    }
  },
  "lg:hidden": {
    "@media (min-width: 1024px)": {
      "display": "none"
    }
  },
  "lg:left-32": {
    "@media (min-width: 1024px)": {
      "left": 128
    }
  },
  "lg:right-auto": {
    "@media (min-width: 1024px)": {
      "right": "auto"
    }
  },
  "lg:min-h-dvh": {
    "@media (min-width: 1024px)": {
      "minHeight": "100dvh"
    }
  },
  "lg:px-8": {
    "@media (min-width: 1024px)": {
      "paddingLeft": 32,
      "paddingRight": 32
    }
  },
  "lg:py-12": {
    "@media (min-width: 1024px)": {
      "paddingTop": 48,
      "paddingBottom": 48
    }
  },
  "lg:top-0": {
    "@media (min-width: 1024px)": {
      "top": 0
    }
  },
  "list-none": {
    "listStyle": "none"
  },
  "max-h-36": {
    "maxHeight": 144
  },
  "max-h-48": {
    "maxHeight": 192
  },
  "max-h-56": {
    "maxHeight": 224
  },
  "max-h-80": {
    "maxHeight": 320
  },
  "max-h-96": {
    "maxHeight": 384
  },
  "max-w-24": {
    "maxWidth": 96
  },
  "max-w-3xl": {
    "maxWidth": 768
  },
  "max-w-5xl": {
    "maxWidth": 1024
  },
  "max-w-[88%]": {
    "maxWidth": "88%"
  },
  "max-w-[94%]": {
    "maxWidth": "94%"
  },
  "max-w-full": {
    "maxWidth": "100%"
  },
  "max-w-md": {
    "maxWidth": 448
  },
  "max-w-xl": {
    "maxWidth": 576
  },
  "mb-2": {
    "marginBottom": 8
  },
  "mb-3": {
    "marginBottom": 12
  },
  "mb-6": {
    "marginBottom": 24
  },
  "mb-7": {
    "marginBottom": 28
  },
  "min-h-0": {
    "minHeight": 0
  },
  "min-h-10": {
    "minHeight": 40
  },
  "min-h-11": {
    "minHeight": 44
  },
  "min-h-14": {
    "minHeight": 56
  },
  "min-h-28": {
    "minHeight": 112
  },
  "min-h-5": {
    "minHeight": 20
  },
  "min-h-[calc(100dvh-52px)]": {
    "minHeight": "calc(100dvh-52px)"
  },
  "min-h-dvh": {
    "minHeight": "100dvh"
  },
  "min-w-0": {
    "minWidth": 0
  },
  "min-w-24": {
    "minWidth": 96
  },
  "ml-1": {
    "marginLeft": 4
  },
  "ml-10": {
    "marginLeft": 40
  },
  "ml-2": {
    "marginLeft": 8
  },
  "ml-auto": {
    "marginLeft": "auto"
  },
  "mr-1.5": {
    "marginRight": 6
  },
  "mt-0.5": {
    "marginTop": 2
  },
  "mt-1": {
    "marginTop": 4
  },
  "mt-1.5": {
    "marginTop": 6
  },
  "mt-2": {
    "marginTop": 8
  },
  "mt-3": {
    "marginTop": 12
  },
  "mt-4": {
    "marginTop": 16
  },
  "mt-5": {
    "marginTop": 20
  },
  "mt-6": {
    "marginTop": 24
  },
  "mt-7": {
    "marginTop": 28
  },
  "mt-8": {
    "marginTop": 32
  },
  "mx-auto": {
    "marginLeft": "auto",
    "marginRight": "auto"
  },
  "object-contain": {
    "objectFit": "contain"
  },
  "opacity-30": {
    "opacity": 0.3
  },
  "opacity-65": {
    "opacity": 0.65
  },
  "order-3": {
    "order": 3
  },
  "outline-none": {
    "outline": "2px solid transparent",
    "outlineOffset": 2
  },
  "overflow-auto": {
    "overflow": "auto"
  },
  "overflow-hidden": {
    "overflow": "hidden"
  },
  "overflow-x-auto": {
    "overflowX": "auto"
  },
  "overflow-y-auto": {
    "overflowY": "auto"
  },
  "p-0": {
    "padding": 0
  },
  "p-2": {
    "padding": 8
  },
  "p-3": {
    "padding": 12
  },
  "p-3.5": {
    "padding": 14
  },
  "p-4": {
    "padding": 16
  },
  "p-5": {
    "padding": 20
  },
  "p-6": {
    "padding": 24
  },
  "pb-1": {
    "paddingBottom": 4
  },
  "pb-1.5": {
    "paddingBottom": 6
  },
  "pb-10": {
    "paddingBottom": 40
  },
  "pb-2": {
    "paddingBottom": 8
  },
  "pb-3": {
    "paddingBottom": 12
  },
  "pb-4": {
    "paddingBottom": 16
  },
  "pb-5": {
    "paddingBottom": 20
  },
  "pb-7": {
    "paddingBottom": 28
  },
  "pl-3.5": {
    "paddingLeft": 14
  },
  "pl-4": {
    "paddingLeft": 16
  },
  "pl-8": {
    "paddingLeft": 32
  },
  "pl-9": {
    "paddingLeft": 36
  },
  "place-items-center": {
    "placeItems": "center"
  },
  "placeholder:text-white/22": {
    "::placeholder": {
      "color": "rgb(255 255 255 / 0.22)"
    }
  },
  "placeholder:text-white/24": {
    "::placeholder": {
      "color": "rgb(255 255 255 / 0.24)"
    }
  },
  "placeholder:text-white/28": {
    "::placeholder": {
      "color": "rgb(255 255 255 / 0.28)"
    }
  },
  "pointer-events-none": {
    "pointerEvents": "none"
  },
  "pr-2": {
    "paddingRight": 8
  },
  "pr-3": {
    "paddingRight": 12
  },
  "pt-1": {
    "paddingTop": 4
  },
  "pt-10": {
    "paddingTop": 40
  },
  "pt-2": {
    "paddingTop": 8
  },
  "pt-3": {
    "paddingTop": 12
  },
  "pt-4": {
    "paddingTop": 16
  },
  "pt-6": {
    "paddingTop": 24
  },
  "px-1": {
    "paddingLeft": 4,
    "paddingRight": 4
  },
  "px-1.5": {
    "paddingLeft": 6,
    "paddingRight": 6
  },
  "px-2": {
    "paddingLeft": 8,
    "paddingRight": 8
  },
  "px-2.5": {
    "paddingLeft": 10,
    "paddingRight": 10
  },
  "px-3": {
    "paddingLeft": 12,
    "paddingRight": 12
  },
  "px-3.5": {
    "paddingLeft": 14,
    "paddingRight": 14
  },
  "px-4": {
    "paddingLeft": 16,
    "paddingRight": 16
  },
  "px-5": {
    "paddingLeft": 20,
    "paddingRight": 20
  },
  "px-8": {
    "paddingLeft": 32,
    "paddingRight": 32
  },
  "py-0.5": {
    "paddingTop": 2,
    "paddingBottom": 2
  },
  "py-1": {
    "paddingTop": 4,
    "paddingBottom": 4
  },
  "py-1.5": {
    "paddingTop": 6,
    "paddingBottom": 6
  },
  "py-10": {
    "paddingTop": 40,
    "paddingBottom": 40
  },
  "py-16": {
    "paddingTop": 64,
    "paddingBottom": 64
  },
  "py-2": {
    "paddingTop": 8,
    "paddingBottom": 8
  },
  "py-2.5": {
    "paddingTop": 10,
    "paddingBottom": 10
  },
  "py-20": {
    "paddingTop": 80,
    "paddingBottom": 80
  },
  "py-3": {
    "paddingTop": 12,
    "paddingBottom": 12
  },
  "py-3.5": {
    "paddingTop": 14,
    "paddingBottom": 14
  },
  "py-4": {
    "paddingTop": 16,
    "paddingBottom": 16
  },
  "py-5": {
    "paddingTop": 20,
    "paddingBottom": 20
  },
  "py-8": {
    "paddingTop": 32,
    "paddingBottom": 32
  },
  "relative": {
    "position": "relative"
  },
  "resize-none": {
    "resize": "none"
  },
  "resize-y": {
    "resize": "vertical"
  },
  "right-2": {
    "right": 8
  },
  "right-3": {
    "right": 12
  },
  "rounded": {
    "borderRadius": 4
  },
  "rounded-2xl": {
    "borderRadius": 16
  },
  "rounded-br-md": {
    "borderBottomRightRadius": 6
  },
  "rounded-full": {
    "borderRadius": 9999
  },
  "rounded-lg": {
    "borderRadius": 8
  },
  "rounded-md": {
    "borderRadius": 6
  },
  "rounded-t-2xl": {
    "borderTopLeftRadius": 16,
    "borderTopRightRadius": 16
  },
  "rounded-xl": {
    "borderRadius": 12
  },
  "scroll-mb-32": {
    "scrollMarginBottom": 128
  },
  "shadow-[0_-20px_70px_rgba(0,0,0,.45)]": {
    "boxShadow": "0 -20px 70px rgba(0,0,0,.45)"
  },
  "shadow-[0_0_0_1px_rgba(255,255,255,.12)_inset]": {
    "boxShadow": "0 0 0 1px rgba(255,255,255,.12) inset"
  },
  "shadow-[0_0_7px_rgba(255,155,115,.55)]": {
    "boxShadow": "0 0 7px rgba(255,155,115,.55)"
  },
  "shadow-[0_0_7px_rgba(84,209,139,.65)]": {
    "boxShadow": "0 0 7px rgba(84,209,139,.65)"
  },
  "shadow-[0_0_7px_rgba(84,209,139,.7)]": {
    "boxShadow": "0 0 7px rgba(84,209,139,.7)"
  },
  "shadow-[0_10px_30px_rgba(0,0,0,.12)]": {
    "boxShadow": "0 10px 30px rgba(0,0,0,.12)"
  },
  "shadow-[0_12px_40px_rgba(0,0,0,.16)]": {
    "boxShadow": "0 12px 40px rgba(0,0,0,.16)"
  },
  "shadow-[0_18px_60px_rgba(0,0,0,.38)]": {
    "boxShadow": "0 18px 60px rgba(0,0,0,.38)"
  },
  "shadow-[0_1px_0_rgba(255,255,255,.06)_inset]": {
    "boxShadow": "0 1px 0 rgba(255,255,255,.06) inset"
  },
  "shadow-[0_24px_80px_rgba(0,0,0,.22)]": {
    "boxShadow": "0 24px 80px rgba(0,0,0,.22)"
  },
  "shadow-[0_8px_24px_rgba(73,69,225,.2)]": {
    "boxShadow": "0 8px 24px rgba(73,69,225,.2)"
  },
  "shadow-xl": {
    "boxShadow": "0 20px 25px -5px rgb(0 0 0 / .3), 0 8px 10px -6px rgb(0 0 0 / .3)"
  },
  "shrink-0": {
    "flexShrink": 0
  },
  "size-1": {
    "width": 4,
    "height": 4
  },
  "size-1.5": {
    "width": 6,
    "height": 6
  },
  "size-10": {
    "width": 40,
    "height": 40
  },
  "size-2": {
    "width": 8,
    "height": 8
  },
  "size-3": {
    "width": 12,
    "height": 12
  },
  "size-3.5": {
    "width": 14,
    "height": 14
  },
  "size-4": {
    "width": 16,
    "height": 16
  },
  "size-6": {
    "width": 24,
    "height": 24
  },
  "size-7": {
    "width": 28,
    "height": 28
  },
  "size-8": {
    "width": 32,
    "height": 32
  },
  "size-9": {
    "width": 36,
    "height": 36
  },
  "sm:flex": {
    "@media (min-width: 640px)": {
      "display": "flex"
    }
  },
  "sm:flex-row": {
    "@media (min-width: 640px)": {
      "flexDirection": "row"
    }
  },
  "sm:grid-cols-2": {
    "@media (min-width: 640px)": {
      "gridTemplateColumns": "repeat(2, minmax(0, 1fr))"
    }
  },
  "sm:h-8": {
    "@media (min-width: 640px)": {
      "height": 32
    }
  },
  "sm:h-9": {
    "@media (min-width: 640px)": {
      "height": 36
    }
  },
  "sm:inline": {
    "@media (min-width: 640px)": {
      "display": "inline"
    }
  },
  "sm:items-center": {
    "@media (min-width: 640px)": {
      "alignItems": "center"
    }
  },
  "sm:justify-between": {
    "@media (min-width: 640px)": {
      "justifyContent": "space-between"
    }
  },
  "sm:max-w-[78%]": {
    "@media (min-width: 640px)": {
      "maxWidth": "78%"
    }
  },
  "sm:max-w-[86%]": {
    "@media (min-width: 640px)": {
      "maxWidth": "86%"
    }
  },
  "sm:max-w-[88%]": {
    "@media (min-width: 640px)": {
      "maxWidth": "88%"
    }
  },
  "sm:max-w-md": {
    "@media (min-width: 640px)": {
      "maxWidth": 448
    }
  },
  "sm:p-5": {
    "@media (min-width: 640px)": {
      "padding": 20
    }
  },
  "sm:p-7": {
    "@media (min-width: 640px)": {
      "padding": 28
    }
  },
  "sm:p-8": {
    "@media (min-width: 640px)": {
      "padding": 32
    }
  },
  "sm:pb-5": {
    "@media (min-width: 640px)": {
      "paddingBottom": 20
    }
  },
  "sm:place-items-center": {
    "@media (min-width: 640px)": {
      "placeItems": "center"
    }
  },
  "sm:pt-9": {
    "@media (min-width: 640px)": {
      "paddingTop": 36
    }
  },
  "sm:px-2.5": {
    "@media (min-width: 640px)": {
      "paddingLeft": 10,
      "paddingRight": 10
    }
  },
  "sm:px-3": {
    "@media (min-width: 640px)": {
      "paddingLeft": 12,
      "paddingRight": 12
    }
  },
  "sm:px-5": {
    "@media (min-width: 640px)": {
      "paddingLeft": 20,
      "paddingRight": 20
    }
  },
  "sm:px-6": {
    "@media (min-width: 640px)": {
      "paddingLeft": 24,
      "paddingRight": 24
    }
  },
  "sm:px-7": {
    "@media (min-width: 640px)": {
      "paddingLeft": 28,
      "paddingRight": 28
    }
  },
  "sm:px-8": {
    "@media (min-width: 640px)": {
      "paddingLeft": 32,
      "paddingRight": 32
    }
  },
  "sm:py-14": {
    "@media (min-width: 640px)": {
      "paddingTop": 56,
      "paddingBottom": 56
    }
  },
  "sm:rounded-2xl": {
    "@media (min-width: 640px)": {
      "borderRadius": 16
    }
  },
  "sm:size-7": {
    "@media (min-width: 640px)": {
      "width": 28,
      "height": 28
    }
  },
  "sm:size-8": {
    "@media (min-width: 640px)": {
      "width": 32,
      "height": 32
    }
  },
  "sr-only": {
    "position": "absolute",
    "width": 1,
    "height": 1,
    "padding": 0,
    "margin": -1,
    "overflow": "hidden",
    "clip": "rect(0, 0, 0, 0)",
    "whiteSpace": "nowrap",
    "borderWidth": 0
  },
  "sticky": {
    "position": "sticky"
  },
  "tabular-nums": {
    "fontVariantNumeric": "tabular-nums"
  },
  "text-2xl": {
    "fontSize": 24
  },
  "text-3xl": {
    "fontSize": 30
  },
  "text-[#6ee2a0]": {
    "fontSize": "#6ee2a0"
  },
  "text-[#6ee2a0]/65": {
    "color": "rgb(110 226 160 / 0.65)"
  },
  "text-[#8dbbff]": {
    "fontSize": "#8dbbff"
  },
  "text-[#8dbbff]/60": {
    "color": "rgb(141 187 255 / 0.6)"
  },
  "text-[#8dbbff]/70": {
    "color": "rgb(141 187 255 / 0.7)"
  },
  "text-[#93e8b7]/70": {
    "color": "rgb(147 232 183 / 0.7)"
  },
  "text-[#9cc3ff]": {
    "fontSize": "#9cc3ff"
  },
  "text-[#a8a6ff]": {
    "fontSize": "#a8a6ff"
  },
  "text-[#c5b6ff]/55": {
    "color": "rgb(197 182 255 / 0.55)"
  },
  "text-[#f3f3f1]": {
    "fontSize": "#f3f3f1"
  },
  "text-[#ff989d]": {
    "fontSize": "#ff989d"
  },
  "text-[#ff989d]/70": {
    "color": "rgb(255 152 157 / 0.7)"
  },
  "text-[#ff9ca1]": {
    "fontSize": "#ff9ca1"
  },
  "text-[#ffae8d]": {
    "fontSize": "#ffae8d"
  },
  "text-[#ffae8d]/70": {
    "color": "rgb(255 174 141 / 0.7)"
  },
  "text-[#ffb0b4]/65": {
    "color": "rgb(255 176 180 / 0.65)"
  },
  "text-[#ffbc9f]": {
    "fontSize": "#ffbc9f"
  },
  "text-[#ffc0a7]": {
    "fontSize": "#ffc0a7"
  },
  "text-[10px]": {
    "fontSize": "10px"
  },
  "text-[11px]": {
    "fontSize": "11px"
  },
  "text-[15px]": {
    "fontSize": "15px"
  },
  "text-[8px]": {
    "fontSize": "8px"
  },
  "text-[9px]": {
    "fontSize": "9px"
  },
  "text-base": {
    "fontSize": 16
  },
  "text-center": {
    "textAlign": "center"
  },
  "text-lg": {
    "fontSize": 18
  },
  "text-right": {
    "textAlign": "right"
  },
  "text-sm": {
    "fontSize": 14
  },
  "text-transparent": {
    "color": "transparent"
  },
  "text-white": {
    "color": "rgb(255 255 255)"
  },
  "text-white/16": {
    "color": "rgb(255 255 255 / 0.16)"
  },
  "text-white/18": {
    "color": "rgb(255 255 255 / 0.18)"
  },
  "text-white/20": {
    "color": "rgb(255 255 255 / 0.2)"
  },
  "text-white/22": {
    "color": "rgb(255 255 255 / 0.22)"
  },
  "text-white/24": {
    "color": "rgb(255 255 255 / 0.24)"
  },
  "text-white/25": {
    "color": "rgb(255 255 255 / 0.25)"
  },
  "text-white/26": {
    "color": "rgb(255 255 255 / 0.26)"
  },
  "text-white/27": {
    "color": "rgb(255 255 255 / 0.27)"
  },
  "text-white/28": {
    "color": "rgb(255 255 255 / 0.28)"
  },
  "text-white/30": {
    "color": "rgb(255 255 255 / 0.3)"
  },
  "text-white/32": {
    "color": "rgb(255 255 255 / 0.32)"
  },
  "text-white/34": {
    "color": "rgb(255 255 255 / 0.34)"
  },
  "text-white/35": {
    "color": "rgb(255 255 255 / 0.35)"
  },
  "text-white/38": {
    "color": "rgb(255 255 255 / 0.38)"
  },
  "text-white/40": {
    "color": "rgb(255 255 255 / 0.4)"
  },
  "text-white/42": {
    "color": "rgb(255 255 255 / 0.42)"
  },
  "text-white/45": {
    "color": "rgb(255 255 255 / 0.45)"
  },
  "text-white/46": {
    "color": "rgb(255 255 255 / 0.46)"
  },
  "text-white/48": {
    "color": "rgb(255 255 255 / 0.48)"
  },
  "text-white/52": {
    "color": "rgb(255 255 255 / 0.52)"
  },
  "text-white/54": {
    "color": "rgb(255 255 255 / 0.54)"
  },
  "text-white/55": {
    "color": "rgb(255 255 255 / 0.55)"
  },
  "text-white/58": {
    "color": "rgb(255 255 255 / 0.58)"
  },
  "text-white/60": {
    "color": "rgb(255 255 255 / 0.6)"
  },
  "text-white/62": {
    "color": "rgb(255 255 255 / 0.62)"
  },
  "text-white/64": {
    "color": "rgb(255 255 255 / 0.64)"
  },
  "text-white/65": {
    "color": "rgb(255 255 255 / 0.65)"
  },
  "text-white/66": {
    "color": "rgb(255 255 255 / 0.66)"
  },
  "text-white/68": {
    "color": "rgb(255 255 255 / 0.68)"
  },
  "text-white/72": {
    "color": "rgb(255 255 255 / 0.72)"
  },
  "text-white/74": {
    "color": "rgb(255 255 255 / 0.74)"
  },
  "text-white/76": {
    "color": "rgb(255 255 255 / 0.76)"
  },
  "text-white/78": {
    "color": "rgb(255 255 255 / 0.78)"
  },
  "text-white/80": {
    "color": "rgb(255 255 255 / 0.8)"
  },
  "text-white/82": {
    "color": "rgb(255 255 255 / 0.82)"
  },
  "text-white/86": {
    "color": "rgb(255 255 255 / 0.86)"
  },
  "text-white/88": {
    "color": "rgb(255 255 255 / 0.88)"
  },
  "text-white/92": {
    "color": "rgb(255 255 255 / 0.92)"
  },
  "text-xl": {
    "fontSize": 20
  },
  "text-xs": {
    "fontSize": 12
  },
  "top-0": {
    "top": 0
  },
  "top-1/2": {
    "top": "50%"
  },
  "top-13": {
    "top": 52
  },
  "tracking-[-0.01em]": {
    "letterSpacing": "-0.01em"
  },
  "tracking-[-0.02em]": {
    "letterSpacing": "-0.02em"
  },
  "tracking-[-0.035em]": {
    "letterSpacing": "-0.035em"
  },
  "tracking-[-0.045em]": {
    "letterSpacing": "-0.045em"
  },
  "tracking-[0.08em]": {
    "letterSpacing": "0.08em"
  },
  "tracking-[0.11em]": {
    "letterSpacing": "0.11em"
  },
  "tracking-[0.12em]": {
    "letterSpacing": "0.12em"
  },
  "tracking-[0.13em]": {
    "letterSpacing": "0.13em"
  },
  "tracking-[0.14em]": {
    "letterSpacing": "0.14em"
  },
  "tracking-[0.15em]": {
    "letterSpacing": "0.15em"
  },
  "tracking-[0.1em]": {
    "letterSpacing": "0.1em"
  },
  "transition": {
    "transitionProperty": "color, background-color, border-color, opacity, box-shadow, transform",
    "transitionDuration": "150ms",
    "transitionTimingFunction": "cubic-bezier(.4,0,.2,1)"
  },
  "truncate": {
    "overflow": "hidden",
    "textOverflow": "ellipsis",
    "whiteSpace": "nowrap"
  },
  "underline": {
    "textDecorationLine": "underline"
  },
  "underline-offset-4": {
    "textUnderlineOffset": 4
  },
  "uppercase": {
    "textTransform": "uppercase"
  },
  "w-[min(22rem,calc(100vw-1.5rem))]": {
    "width": "min(22rem,calc(100vw-1.5rem))"
  },
  "w-full": {
    "width": "100%"
  },
  "whitespace-nowrap": {
    "whiteSpace": "nowrap"
  },
  "whitespace-pre-wrap": {
    "whiteSpace": "pre-wrap"
  },
  "xl:block": {
    "@media (min-width: 1280px)": {
      "display": "block"
    }
  },
  "xl:flex": {
    "@media (min-width: 1280px)": {
      "display": "flex"
    }
  },
  "xl:flex-1": {
    "@media (min-width: 1280px)": {
      "flex": "1 1 0%"
    }
  },
  "xl:flex-col": {
    "@media (min-width: 1280px)": {
      "flexDirection": "column"
    }
  },
  "xl:grid": {
    "@media (min-width: 1280px)": {
      "display": "grid"
    }
  },
  "xl:grid-cols-[minmax(0,1.25fr)_minmax(280px,.75fr)]": {
    "@media (min-width: 1280px)": {
      "gridTemplateColumns": "minmax(0,1.25fr) minmax(280px,.75fr)"
    }
  },
  "xl:grid-cols-[minmax(0,1fr)_320px]": {
    "@media (min-width: 1280px)": {
      "gridTemplateColumns": "minmax(0,1fr) 320px"
    }
  },
  "xl:h-dvh": {
    "@media (min-width: 1280px)": {
      "height": "100dvh"
    }
  },
  "xl:hidden": {
    "@media (min-width: 1280px)": {
      "display": "none"
    }
  },
  "xl:min-h-0": {
    "@media (min-width: 1280px)": {
      "minHeight": 0
    }
  },
  "xl:overflow-y-auto": {
    "@media (min-width: 1280px)": {
      "overflowY": "auto"
    }
  },
  "xl:px-12": {
    "@media (min-width: 1280px)": {
      "paddingLeft": 48,
      "paddingRight": 48
    }
  },
  "z-1": {
    "zIndex": 1
  },
  "z-2": {
    "zIndex": 2
  },
  "z-20": {
    "zIndex": 20
  },
  "z-50": {
    "zIndex": 50
  }
});

const structuralTokens = new Set([
  "animate-pulse",
  "bg-gradient-to-t",
  "divide-white/[0.055]",
  "divide-white/[0.07]",
  "divide-x",
  "divide-y",
  "from-[#111113]",
  "group",
  "group-hover:text-white",
  "group-hover:text-white/78",
  "group-last:border-0",
  "group-open/execution:rotate-45",
  "group/execution",
  "no-scrollbar",
  "peer",
  "space-y-0.5",
  "space-y-1",
  "space-y-1.5",
  "space-y-2",
  "space-y-2.5",
  "space-y-3",
  "space-y-6",
  "space-y-8",
  "to-transparent",
  "via-[#111113]"
]);

export function sx(...values: SxValue[]) {
  const tokens = values.filter((value): value is string => typeof value === "string" && value.length > 0).flatMap((value) => value.split(/\s+/)).filter(Boolean);
  const unresolved = tokens.filter((token) => utilityStyles[token as keyof typeof utilityStyles] === undefined && !structuralTokens.has(token));
  if (unresolved.length > 0) {
    throw new Error(`Unknown StyleX token: ${unresolved.join(", ")}`);
  }
  const resolved = tokens.map((token) => utilityStyles[token as keyof typeof utilityStyles]).filter((style): style is Exclude<typeof style, undefined> => style !== undefined);
  const props = stylex.props(...resolved);
  const structural = tokens.filter((token) => structuralTokens.has(token));
  return structural.length === 0 ? props : { ...props, className: [props.className, ...structural].filter(Boolean).join(" ") };
}
