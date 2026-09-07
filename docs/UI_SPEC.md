# ALTREX CODE UI and Brand Specification

## Official two-logo system

ALTREX has two supplied official marks. They are never substituted, recolored, redrawn, or assigned each other's roles.

### Logo A — product identity

Logo A is the rounded open frame containing the geometric A and integrated forward arrow. It identifies the ALTREX product and company.

Use it for the Windows executable, taskbar, shortcuts, Start Menu, installer metadata, startup splash, window identity, top-left sidebar brand, collapsed sidebar, About page, and product notifications. Normal navigation pairs the 20–24px mark with the short name `ALTREX`. The full name `ALTREX CODE` is reserved for startup, metadata, settings, installer, About, and marketing.

### Logo B — coding intelligence

Logo B is the supplied `</>` symbol. It identifies ALTREX coding intelligence.

Use it above the empty-home heading, and optionally as a subtle 18–22px assistant or overall working-state identity. It is never the executable or taskbar icon and is not repeated beside every agent operation.

Source and derived assets live only in `apps/desktop/assets/branding/`. The ICO contains 16, 24, 32, 48, 64, 128, and 256px frames. Raster source is retained because no official vector source was supplied; an invented SVG trace is prohibited.

## Visual language

Neutral charcoal, compact typography, restrained borders and the original marks. No decorative gradients, glow, fabricated activity or unsupported navigation.

Tokens live in `apps/desktop/src/renderer/src/styles.css`: app #161616, sidebar #1b1b1b, surface #222222, composer #272727, subtle border #2b2b2b, primary text #eeeeec, secondary text #b0b0ac. Inter is the UI font; JetBrains Mono is the code font. Controls use 6–8px radii; composer and dialogs use 12px. Motion is 150–180ms and respects reduced motion.

## Shell and navigation

A 240px sidebar collapses to a functional 56px icon rail. A 48px workspace bar contains actual project/branch context, conversation title, commands, settings, and task results only when results exist. The native Electron window frame remains intact.

Navigation provides New chat, Search, Open project, current project, stored current-project conversations, and Settings. Sections collapse independently and history scrolls. There is no hardcoded profile, fake project list, or roadmap navigation.

## Home and composer

The home contains Logo B, the heading `What should we build?`, and four compact Explore, Build, Review and Fix cards. Cards populate and focus the real composer.

The composer stays near the bottom, with a maximum width of 780px. Its project indicator opens the native folder picker. Its textarea grows to 200px, supports IME input and multiline text, and keeps controls visible. Add context opens the actual attachment/project menu. Ask and Agent connect to existing execution modes. The model popup searches actual configured/discovered models and exposes provider connection. Send becomes Stop during a running request.

- Enter: send; Shift+Enter: newline.
- Ctrl/Cmd+N: new chat, preserving history.
- Ctrl/Cmd+P or Ctrl/Cmd+Shift+P: search conversations and commands.
- Escape: close a menu or dialog.

## Conversation and results

User prompts use small right-aligned bubbles. Responses use a readable document layout. Working time and operational status accompany real activity events. Commands and changed paths appear as compact expandable rows. Code fences have language labels, copy actions and horizontal scrolling. Raw model HTML is never rendered.

The optional results panel lists only actual changed files and command output. It can be closed. No interactive file explorer or terminal control is shown because the desktop bridge does not expose those capabilities.

History preserves the original local conversation storage while adding project-scoped saved conversations. New chat does not erase prior history. Switching project never continues an unrelated conversation against another folder.

## Settings and accessibility

Settings groups the existing AI/provider, appearance and permissions information. Provider configuration continues to use native encrypted credentials. UI controls have accessible names, visible focus, hover and disabled states. Dialogs trap focus and restore it on close; menus support arrow keys, Escape and outside clicks. Scrollbars are thin and neutral. Streaming never forces a reader away from older messages.

Validate at 1920×1080, 1600×900, 1440×900 and 1366×768, with the sidebar both expanded and collapsed. Secondary results become an overlay on narrower windows. The composer and menus must remain inside the viewport.

See `UI_REBUILD.md` for the preservation map, implementation details and QA boundaries.
