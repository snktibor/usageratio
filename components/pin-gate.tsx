import { PinForm } from "@/components/pin-form";

/** The only thing an unauthenticated visitor ever receives: no usage data is rendered here. */
export function PinGate() {
  return (
    <main className="mx-auto w-full max-w-4xl px-5 pt-6 sm:px-8 sm:pt-8">
      <p className="text-lg font-medium tracking-tight">usageratio</p>

      <div className="mt-[18vh]">
        <h1 id="pin-heading" className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Add meg a PIN-kódot
        </h1>
        <p className="mt-4 max-w-md text-ink-2">
          A heti tokenkeret adatai csak a helyes, 5 jegyű kód után töltődnek be.
        </p>
        <PinForm labelledBy="pin-heading" />
      </div>
    </main>
  );
}
