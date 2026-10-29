import { EmptyState } from "../../../src/ui.tsx";

export default function Spend() {
  return (
    <EmptyState
      symbol="creditcard"
      title="No agents yet"
      message="Your agents and their balances will show here."
    />
  );
}
