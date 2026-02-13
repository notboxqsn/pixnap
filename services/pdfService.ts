import { printToFileAsync } from 'expo-print';

/**
 * Generates a PDF file containing the scanned image.
 * Returns the file URI of the created PDF.
 */
export async function generatePdf(base64Png: string, width: number, height: number): Promise<string> {
  const aspect = width / height;
  const pageWidth = 595; // A4 points width
  const margin = 40;
  const imgWidth = pageWidth - margin * 2;
  const imgHeight = imgWidth / aspect;

  const html = `
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body {
            margin: 0;
            padding: ${margin}px;
            display: flex;
            justify-content: center;
            align-items: flex-start;
          }
          img {
            width: ${imgWidth}px;
            height: ${imgHeight}px;
            object-fit: contain;
          }
        </style>
      </head>
      <body>
        <img src="data:image/png;base64,${base64Png}" />
      </body>
    </html>
  `;

  const { uri } = await printToFileAsync({ html });
  return uri;
}
