export function SectionIndex({
  index,
  children,
  inverted = false,
}: {
  index: string;
  children: React.ReactNode;
  inverted?: boolean;
}) {
  return (
    <div className={`section-index${inverted ? " section-index--inverted" : ""}`}>
      <span>{index}</span>
      <p>{children}</p>
    </div>
  );
}

