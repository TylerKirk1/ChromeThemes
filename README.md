# ChromeThemes

A Chrome extension that recolors any website with a theme you pick or make yourself.

Rather than painting a tint over the page, it reads each site's own stylesheets and writes a matching set where every color is remapped onto the theme: backgrounds land near the theme background, text near the theme text, and colorful elements keep their meaning at a readable brightness (or take the theme's accent). Only colors change, so layouts never break, and it works on light and dark sites alike.

14 built-in themes, a custom theme editor, and per-site on/off and theme overrides.

**Effects (beta):** glass buttons, either frosted or "liquid" (a lens that bends what's behind the button, using Chrome's SVG backdrop filters), and an ombre gradient behind the page. Fixed headers, menus and dialogs stay solid so text never overlaps.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Pin ChromeThemes to the toolbar and pick a theme.

Chrome doesn't allow extensions on its own pages (`chrome://`, the Web Store, the PDF viewer), so those stay unthemed.
