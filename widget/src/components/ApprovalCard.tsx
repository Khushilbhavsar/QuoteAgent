import type { QuoteDraft } from "../types";

interface ApprovalCardProps {
  draft: QuoteDraft;
  busy: boolean;
  onDecision: (approved: boolean) => void;
}

const gbp = (value: number): string =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value);

/** The human-in-the-loop approval card: shows the priced quote draft the
    agent built and lets the customer approve (save it) or decline. */
export function ApprovalCard({ draft, busy, onDecision }: ApprovalCardProps): JSX.Element {
  return (
    <div className="approval-card" role="group" aria-label="Quote awaiting approval">
      <div className="approval-card__title">Quote for approval</div>
      <div className="approval-card__meta">
        {draft.name} &middot; {draft.email}
      </div>

      <table className="approval-card__table">
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Qty</th>
            <th className="num">Unit</th>
            <th className="num">Line</th>
          </tr>
        </thead>
        <tbody>
          {draft.items.map((line) => (
            <tr key={line.sku}>
              <td>
                {line.name}
                <span className="approval-card__sku">{line.sku}</span>
              </td>
              <td className="num">{line.quantity}</td>
              <td className="num">{gbp(line.unit_price_gbp)}</td>
              <td className="num">{gbp(line.line_total_gbp)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>Total (excl. delivery)</td>
            <td className="num">{gbp(draft.total_gbp)}</td>
          </tr>
        </tfoot>
      </table>

      {draft.notes !== undefined && draft.notes !== "" && (
        <div className="approval-card__notes">Notes: {draft.notes}</div>
      )}

      <div className="approval-card__actions">
        <button
          type="button"
          className="btn btn--approve"
          disabled={busy}
          onClick={() => onDecision(true)}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn btn--decline"
          disabled={busy}
          onClick={() => onDecision(false)}
        >
          Decline
        </button>
      </div>
    </div>
  );
}
