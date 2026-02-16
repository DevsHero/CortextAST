use anyhow::Result;
use quick_xml::events::{BytesCData, BytesDecl, BytesEnd, BytesStart, Event};
use quick_xml::Writer;
use std::io::Cursor;

pub fn build_context_xml(files: &[(String, String)]) -> Result<String> {
    let mut writer = Writer::new(Cursor::new(Vec::new()));

    writer.write_event(Event::Decl(BytesDecl::new("1.0", Some("utf-8"), None)))?;

    let root = BytesStart::new("context_slicer");
    writer.write_event(Event::Start(root))?;

    for (path, content) in files {
        let mut file_el = BytesStart::new("file");
        file_el.push_attribute(("path", path.as_str()));
        writer.write_event(Event::Start(file_el))?;

        // Write CDATA content.
        writer.write_event(Event::CData(BytesCData::new(content.as_str())))?;
        writer.write_event(Event::End(BytesEnd::new("file")))?;
    }

    writer.write_event(Event::End(BytesEnd::new("context_slicer")))?;

    let bytes = writer.into_inner().into_inner();
    Ok(String::from_utf8(bytes)?)
}
