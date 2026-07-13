import sharp from 'sharp';

const color = '#E91E63';
const letter = 'S';

function svg(size) {
  const fontSize = Math.round(size * 0.55);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect width="${size}" height="${size}" rx="${Math.round(size * 0.18)}" fill="${color}"/>
    <text x="50%" y="50%" dy="0.35em" text-anchor="middle"
      font-family="Arial, sans-serif" font-weight="bold"
      font-size="${fontSize}" fill="white">${letter}</text>
  </svg>`;
}

async function build() {
  for (const size of [192, 512]) {
    await sharp(Buffer.from(svg(size)))
      .png()
      .toFile(`public/pwa-${size}x${size}.png`);
    console.log(`Generado public/pwa-${size}x${size}.png`);
  }
  // Icono enmascarable (con mas relleno alrededor para Android)
  await sharp(Buffer.from(svg(512)))
    .png()
    .toFile('public/maskable-512x512.png');
  console.log('Generado public/maskable-512x512.png');
}

build();
