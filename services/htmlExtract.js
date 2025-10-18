export async function extractMainText(html, url="") {
  try {
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g," ").trim() : "";
    const body = html.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"");
    const text = body.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
    return { title, text };
  } catch (e) {
    return { title:"", text:"" };
  }
}