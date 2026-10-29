import { EmptyState } from "../../../src/ui.tsx";

export default function Account() {
  return (
    <EmptyState
      symbol="person.crop.circle"
      title="Not signed in"
      message="Your sign-in, email and payouts will show here."
    />
  );
}
