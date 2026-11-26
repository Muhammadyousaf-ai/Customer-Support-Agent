"use client";

import { useParams } from "next/navigation";
import { KbEditor } from "@/features/kb/components/kb-editor";

export default function KbDocument() {
  return <KbEditor id={useParams<{ id: string }>().id} />;
}
