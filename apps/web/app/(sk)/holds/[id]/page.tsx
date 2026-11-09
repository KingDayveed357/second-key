import { Review } from "./review";

export const metadata = { title: "Review a payment · Second Key" };

// The trusted contact's page. The credential arrives in the link's fragment (/holds/:id#k=…) or from
// the guardian's phone window in this tab; it never travels in a URL the server sees (ADR-0020 §5).
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="stack-lg">
      <header className="stack-sm" style={{ maxWidth: 440, margin: "0 auto", width: "100%" }}>
        <span className="sk-section-title">A paused payment</span>
      </header>
      <Review id={id} />
    </div>
  );
}
