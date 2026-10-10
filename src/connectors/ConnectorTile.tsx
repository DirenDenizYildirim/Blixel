// A connector's picture: its template's pixel art on a rounded tile, in the connector's colour.

import { PixelArt } from "../mods/page/ModIcon";
import type { Connector } from "../model/types";
import { connectorArt, slugHue, type TileArt } from "./pixel-icons";
import { CUSTOM, templateById } from "./templates";

/** A template's picture, or the custom one's, in the template's own colour. */
export function templateArt(id: string | null): TileArt {
  const t = templateById(id);
  return t ? connectorArt(t.icon, t.hue) : connectorArt(CUSTOM.icon, CUSTOM.hue);
}

/** A connector's picture: its template's in that template's colour, or a plug coloured from its slug. */
export function artFor(connector: Pick<Connector, "template" | "slug">): TileArt {
  const t = templateById(connector.template);
  return t ? connectorArt(t.icon, t.hue) : connectorArt(CUSTOM.icon, slugHue(connector.slug));
}

export function ConnectorTile({ art, size = 72 }: { art: TileArt; size?: number }) {
  // Whole screen pixels per icon pixel look sharpest: 4 per pixel on the usual 72 px tile.
  const pixels = Math.max(1, Math.floor((size - 8) / 16)) * 16;
  return (
    <div className="conn-tile" style={{ width: size, height: size, ["--tint" as string]: art.tint }} aria-hidden="true">
      <PixelArt icon={art.icon} size={pixels} />
    </div>
  );
}
