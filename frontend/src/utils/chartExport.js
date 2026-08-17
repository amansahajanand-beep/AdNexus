/**
 * Export the first Recharts SVG inside a container as a PNG download.
 * No extra dependencies — SVG → canvas → blob.
 */
export function exportChartAsPng(container, filename = 'chart') {
  if (!container || typeof document === 'undefined') return Promise.resolve(false);
  const svg = container.querySelector('svg.recharts-surface, .recharts-wrapper svg, svg');
  if (!svg) return Promise.resolve(false);

  const clone = svg.cloneNode(true);
  if (!clone.getAttribute('xmlns')) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  const bbox = svg.getBoundingClientRect();
  const width = Math.max(1, Math.round(bbox.width || Number(svg.getAttribute('width')) || 640));
  const height = Math.max(1, Math.round(bbox.height || Number(svg.getAttribute('height')) || 320));
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));

  const serializer = new XMLSerializer();
  const source = serializer.serializeToString(clone);
  const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = width * 2;
        canvas.height = height * 2;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(2, 2);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((pngBlob) => {
          URL.revokeObjectURL(url);
          if (!pngBlob) {
            resolve(false);
            return;
          }
          const a = document.createElement('a');
          const safe = String(filename || 'chart').replace(/[^\w\-]+/g, '_').slice(0, 80);
          a.href = URL.createObjectURL(pngBlob);
          a.download = `${safe || 'chart'}.png`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
          resolve(true);
        }, 'image/png');
      } catch {
        URL.revokeObjectURL(url);
        resolve(false);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(false);
    };
    img.src = url;
  });
}
