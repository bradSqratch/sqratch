import Image from "next/image";

export type SqratchLogoProps = {
  className?: string;
  priority?: boolean;
};

export function SqratchLogo({
  className,
  priority = false,
}: SqratchLogoProps) {
  return (
    <Image
      src="/sqratchLogo.svg"
      alt="SQRATCH"
      width={333}
      height={58}
      priority={priority}
      className={className}
    />
  );
}
