import { useState } from 'react'

export default function Footer() {
  const year = new Date().getFullYear()
  const [vgiLogoFailed, setVgiLogoFailed] = useState(false)
  const [csLogoFailed, setCsLogoFailed] = useState(false)

  return (
    <footer className="brand-footer-bg relative shrink-0 border-t border-cs-hair">
      <div
        className="absolute inset-x-0 top-0 h-[2px] bg-[linear-gradient(90deg,transparent,rgba(79,70,229,0.55),transparent)]"
        aria-hidden="true"
      />

      <div className="relative grid grid-cols-1 md:grid-cols-3 items-center gap-3 px-6 py-2">
        <div className="flex items-center gap-3 justify-self-start">
          {!csLogoFailed ? (
            <div className="relative">
              <div
                className="absolute inset-0 rounded-full bg-[radial-gradient(circle,rgba(79,70,229,0.22),transparent_70%)] blur-md"
                aria-hidden="true"
              />
              <img
                src="/cybersentineldlp-logo.png"
                alt="CyberSentinelDLP"
                className="relative h-8 w-8 object-contain"
                onError={() => setCsLogoFailed(true)}
              />
            </div>
          ) : (
            <div className="h-8 w-8 rounded-md bg-cs-indigo" />
          )}
          <div className="flex flex-col leading-tight">
            <span className="brand-gradient-text text-base font-bold tracking-tight">
              CyberSentinel
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-indigo-500">
              Data Loss Prevention
            </span>
          </div>
        </div>

        <div className="hidden md:flex justify-self-center items-center gap-3 text-xs text-cs-muted">
          <span className="h-1 w-1 rounded-full bg-cs-muted-2" aria-hidden="true" />
          <span className="whitespace-nowrap">
            &copy; {year}{' '}
            <span className="text-cs-ink font-semibold">Virtual Galaxy Infotech Ltd.</span>{' '}
            All rights reserved.
          </span>
          <span className="h-1 w-1 rounded-full bg-cs-muted-2" aria-hidden="true" />
        </div>

        <a
          href="https://vgipl.com"
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-3 justify-self-end"
          title="Virtual Galaxy Infotech Ltd."
        >
          <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-cs-muted transition-colors group-hover:text-cs-indigo">
            Powered by
          </span>
          {!vgiLogoFailed ? (
            <div className="relative">
              <div
                className="absolute -inset-0.5 rounded-lg bg-[linear-gradient(90deg,transparent,rgba(79,70,229,0.45),transparent)] opacity-0 blur transition-opacity duration-300 group-hover:opacity-100"
                aria-hidden="true"
              />
              <div
                className="brand-card-light relative flex items-center justify-center rounded-md px-3 py-1.5 shadow-[0_2px_10px_rgba(15,23,42,0.12)] ring-1 ring-black/5 transition-all duration-200 group-hover:-translate-y-0.5 group-hover:shadow-[0_6px_18px_rgba(79,70,229,0.35)]"
              >
                <img
                  src="/vgi-logo.png"
                  alt="Virtual Galaxy Infotech Ltd."
                  className="h-6 w-auto object-contain block"
                  onError={() => setVgiLogoFailed(true)}
                />
              </div>
            </div>
          ) : (
            <span className="text-sm font-semibold text-cs-ink group-hover:text-cs-indigo transition-colors">
              Virtual Galaxy Infotech
            </span>
          )}
        </a>
      </div>

      <p className="md:hidden text-center pb-2 text-[11px] text-cs-muted">
        &copy; {year} Virtual Galaxy Infotech Ltd.
      </p>
    </footer>
  )
}
