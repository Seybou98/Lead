/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Même bleu nuit que la sidebar du CRM principal
        brand: {
          DEFAULT: '#023047',
          soft: '#0b4a6b',
        },
      },
    },
  },
  plugins: [],
};
