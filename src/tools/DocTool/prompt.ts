export const WRITE_DESCRIPTION = `Create and write office documents (PDF, Word, PowerPoint, Excel).

Supports:
- PDF (.pdf): Create new PDF with text and basic formatting
- Word (.docx): Create documents with paragraphs, headings, and tables
- PowerPoint (.pptx): Create presentations with slides
- Excel (.xlsx): Create spreadsheets with data

Use this tool when you need to create office documents programmatically.`

export const WRITE_PROMPT = `## DocWrite Tool

This tool creates office documents. For **DOCX/PPTX**, it uses **Pandoc (Markdown → DOCX/PPTX)** to keep formatting stable; other formats use Python libraries.

### Supported Formats
- **PDF**: Uses reportlab for PDF generation
- **Word (.docx)**: Uses Pandoc for document creation (recommended)
- **PowerPoint (.pptx)**: Uses Pandoc for presentation creation (recommended)
- **Excel (.xlsx)**: Uses openpyxl for spreadsheet creation

IMPORTANT
- Output file extension must be one of: .pdf, .docx, .pptx, .xlsx
- **.md is NOT supported**. If you want a plain Markdown file, use the Write tool to write a .md file.
- Install Pandoc on Windows: \`winget install --id JohnMacFarlane.Pandoc -e\`

### Parameters
- \`file_path\`: Absolute path for the output document
- \`content\`: Content to write (text, markdown, or JSON structure)
- \`template\`: Optional reference file for Pandoc: \`reference.docx\` (DOCX) or \`reference.pptx\` (PPTX)
- \`options\`: Format-specific options (font, size, etc.)

### Content Format
For structured documents, use JSON:
\`\`\`json
{
  "title": "Document Title",
  "sections": [
    {"heading": "Section 1", "content": "..."},
    {"heading": "Section 2", "content": "..."}
  ]
}
\`\`\`

For Excel:
\`\`\`json
{
  "sheets": {
    "Sheet1": [["A1", "B1"], ["A2", "B2"]],
    "Sheet2": [["Data", "Value"]]
  }
}
\`\`\`

### Best Practices
- Use structured JSON for complex documents
- Provide clear headings and sections
- For presentations, provide slide-by-slide content`
