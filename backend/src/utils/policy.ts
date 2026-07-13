// Espejo en backend de src/lib/policy.ts del frontend.
// IMPORTANTE: la validación de contenido NUNCA debe vivir solo en el cliente,
// porque cualquiera puede pegarle directo a la API saltándose el frontend.
// Esta es la copia que realmente protege algo.

const phoneLoose = /(\+?\d[\d\s().-]{7,}\d)/;

const forbiddenWords = [
  'whatsapp', 'wa.me', 'telegram', 't.me', 'tel:',
  'llámame', 'llamame', 'número', 'numero', 'phone',
  'dm me', 'contáctame', 'contactame',
  'escort', 'escorta', 'prostitución', 'prostitucion',
  'servicio', 'encuentro', 'cita', 'hotel', 'en persona', 'presencial',
];

export function containsForbiddenContact(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (phoneLoose.test(t)) return true;
  return forbiddenWords.some((w) => t.includes(w));
}
