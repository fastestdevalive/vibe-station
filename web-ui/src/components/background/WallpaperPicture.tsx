import { objectPosition } from "./focal";

/**
 * One wallpaper picture: plain or baked, window or preview. This is the ONE
 * place the focal crop is applied to a picture, so swapping the plain image for
 * the baked one changes only the texture, never the framing.
 */
export interface PictureLayerProps {
  id: string;
  src: string;
  className?: string;
  /**
   * The bundled thumb is already a 16:9 crop centred on the focal band, so it is
   * drawn centred: applying the focal point again would frame it differently from
   * the full image on any window that is not 16:9.
   */
  isThumb?: boolean;
}

export function PictureLayer({
  id,
  src,
  className,
  isThumb = false,
}: PictureLayerProps): React.JSX.Element {
  return (
    <img
      className={className === undefined ? "wp-picture" : `wp-picture ${className}`}
      src={src}
      alt=""
      draggable={false}
      style={{ objectPosition: isThumb ? "50% 50%" : objectPosition(id) }}
    />
  );
}
