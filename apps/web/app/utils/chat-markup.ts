export type MarkupStroke = { points: { x: number; y: number }[]; color: string; width: number };

export function markupOutline(color: string) {
  const hex = color.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(at => Number.parseInt(hex.slice(at, at + 2), 16));
  return r! * 0.299 + g! * 0.587 + b! * 0.114 < 80 ? '#ffffff' : '#000000';
}

// The same canvas is previewed and exported, including the outline around dots and curves.
export function drawMarkup(context: CanvasRenderingContext2D, stroke: MarkupStroke) {
  if (!stroke.points.length) return;
  for (const [color, width] of [[markupOutline(stroke.color), stroke.width * 5 / 3],
    [stroke.color, stroke.width]] as const) {
    context.beginPath();
    if (stroke.points.length === 1) {
      const point = stroke.points[0]!;
      context.fillStyle = color;
      context.arc(point.x, point.y, width / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.strokeStyle = color;
      context.lineWidth = width;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      for (const [index, point] of stroke.points.entries()) {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      }
      context.stroke();
    }
  }
}
