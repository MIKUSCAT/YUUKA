export const READ_DESCRIPTION = `Read and extract content from office documents (PDF, Word, PowerPoint, Excel).

Supports:
- PDF (.pdf): Extract text content and metadata
- Word (.docx): Extract text, paragraphs, and tables
- PowerPoint (.pptx): Extract slides content and notes
- Excel (.xlsx): Extract sheet data as text or JSON

Use this tool when you need to read content from office documents that FileReadTool cannot handle.`

export const READ_PROMPT = `## DocRead Tool

This tool reads content from office documents using Python libraries.

### Supported Formats
- **PDF**: Uses PyMuPDF (fitz) for text extraction
- **Word (.docx)**: Uses python-docx for document parsing
- **PowerPoint (.pptx)**: Uses python-pptx for slide extraction
- **Excel (.xlsx)**: Uses openpyxl for spreadsheet reading

### Parameters
- \`file_path\`: Absolute path to the document
- \`format\`: Output format - 'text' (default), 'json', or 'markdown'
- \`sheet\`: For Excel files, specify sheet name or index (default: all sheets)
- \`pages\`: For PDF files, specify page range like "1-5" or "1,3,5"

### Best Practices
- For large documents, consider reading specific pages/sheets
- Use JSON format when you need structured data extraction
- Use markdown format for formatted output`

export const WRITE_DESCRIPTION = `Create and write office documents (PDF, Word, PowerPoint, Excel).

Supports:
- PDF (.pdf): Create new PDF with text and basic formatting
- Word (.docx): Create documents with paragraphs, headings, and tables
- PowerPoint (.pptx): Create presentations with slides
- Excel (.xlsx): Create spreadsheets with data

Use this tool when you need to create office documents programmatically.`

export const WRITE_PROMPT = `## DocWrite Tool

This tool creates office documents using Python libraries.

### Supported Formats
- **PDF**: Uses reportlab for PDF generation
- **Word (.docx)**: Uses python-docx for document creation
- **PowerPoint (.pptx)**: Uses python-pptx for presentation creation
- **Excel (.xlsx)**: Uses openpyxl for spreadsheet creation

⚠️ IMPORTANT
- Output file extension must be one of: .pdf, .docx, .pptx, .xlsx
- **.md is NOT supported**. If you want a plain Markdown file, use the Replace tool to write a .md file.

### Parameters
- \`file_path\`: Absolute path for the output document
- \`content\`: Content to write (text, markdown, or JSON structure)
- \`template\`: Optional template file path
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
