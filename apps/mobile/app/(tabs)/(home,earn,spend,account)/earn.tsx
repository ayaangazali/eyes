import { EmptyState } from "../../../src/ui.tsx";

export default function Earn() {
  return (
    <EmptyState
      symbol="dollarsign.circle"
      title="No tasks yet"
      message="Paid tasks near you will show here. Until then, Eyes texts them to you."
    />
  );
}
