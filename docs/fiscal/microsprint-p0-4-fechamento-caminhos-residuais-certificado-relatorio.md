# Microsprint P0.4 — Fechamento dos caminhos residuais de certificado

**Prioridade:** P0 — Segurança fiscal  
**Data:** 18/10/2026  
**Dependência:** P0.2 (NFC-e 65) · P0.3 (NF-e 55)  
**Decisão final:** **APROVADA COM RESSALVAS**

Nesta etapa **não** houve SOAP SEFAZ real de status/emissão nas suítes, DistDFe, 210210, PFX de produção, alteração de NSU/cooldown/filas da Central, commit, push ou merge. As suítes de teste usaram preload/`isolarBancoTeste` com SQLite em `%TEMP%` ou `:memory:`.

---

## 1. Causa-raiz

Após P0.2/P0.3, emissão e cancelamento NFC-e 65 e NF-e 55 passaram pelo gate `exigirCertificadoAptoParaUsoFiscal`. Permaneciam caminhos residuais que:

1. Inferiam empresa via configuração global.
2. Consultavam status SEFAZ no diagnóstico sem autorização explícita.
3. Tratavam checklist/UI e status administrativo `PRONTA` como prova criptográfica.
4. Permitiam persistir caminho arbitrário (ou de outra empresa) via PUT administrativo, deixando só o gate de uso como última barreira.
5. Resolviam UF/CFOP/emitente de preparação/ficha sem `empresaId` do documento.

---

## 2. Matriz dos caminhos residuais auditados

| # | Ponto de entrada / serviço | Origem `empresaId` | Abre PKCS#12 | SOAP/TLS SEFAZ | Gate | Resultado |
|---|---|---|---|---|---|---|
| 1 | `nfeOperacionalService.executarDiagnosticoFiscal` (local) | Obrigatório explícito | Não (usa snapshot) | Não SOAP; DNS/HTTPS de conectividade ao host SVRS | N/A local | **Corrigido** — padrão local |
| 2 | Mesmo método (remoto `remoto=true`) | Obrigatório | Sim — via gate | Status serviço só com `autorizacaoTransmissaoSefaz` + tipo `statusServico` | **Sim** | **Corrigido** — produção bloqueada sem TESTE_ISOLADO |
| 3 | Rota `GET/POST` diagnóstico NF-e (`rotas/nfe.js`) | Query/body `empresa_id` | Conforme modo | Conforme modo | Conforme modo | **Corrigido** |
| 4 | `CentralFaturamentoService.inspecionarCertificadoEmpresa` | `venda.empresa_id` / arg | Só se `revalidar=true` (fluxo teste seguro) | Não | Snapshot `apto_certificado_criptografico` | **Corrigido** |
| 5 | `inspecionarCertificado` (legado) | — | Não | Não | — | **Bloqueado** — devolve não apto + mensagem |
| 6 | `salvarConfiguracaoFiscalEmpresa` (PUT admin) | Empresa do recurso | Não | Não | Path contido + não força `VÁLIDO` | **Corrigido** |
| 7 | `CertificadoEmpresaService.substituir/testar` | Explícito + auth | Sim — `validarArquivoPfx` | Não | Snapshot com `confiarSnapshotValidacao` | **Mantido/endurecido** |
| 8 | `prepararNfeDevolucaoVenda/Compra` | `venda/compra.empresa_id` | Não | Não | N/A | **Corrigido** contexto |
| 9 | `obterFichaDocumentalNfe` | Empresa da venda | Não | Não | N/A | **Corrigido** contexto |
| 10 | Pipelines emit/cancel 65/55 | Documento | Sim após gate | Sim após gate | **Intactos** | Regressão verde |

---

## 3. Arquivos alterados e justificativa

| Arquivo | Justificativa |
|---|---|
| `backend/services/fiscal/nfeOperacionalService.js` | Diagnóstico local vs remoto; empresa obrigatória; gate + auth no remoto |
| `backend/services/fiscal/autorizacaoTransmissaoSefaz.js` | Tipo `statusServico` para diagnóstico remoto |
| `backend/rotas/nfe.js` | Propaga `empresaId` / flag remoto |
| `backend/services/faturamento/CentralFaturamentoService.js` | Checklist por empresa + estados criptográficos |
| `backend/services/fiscal/empresasConfiguracaoFiscal.js` | Path admin só na pasta protegida; rejeita `VÁLIDO` forjado sem `confiarSnapshotValidacao` |
| `backend/services/fiscal/CertificadoEmpresaService.js` | Propaga `pastaCertificados` + `confiarSnapshotValidacao` nas gravações confiáveis |
| `backend/services/fiscal/CertificadoUsoFiscalGate.js` | Propaga `pastaCertificados` no persistir snapshot |
| `backend/services/fiscal/nfeDevolucaoVenda.js` / `nfeDevolucaoCompra.js` | `preparar*` com `getFiscalConfig({ empresaId })` |
| `backend/services/fiscal/nfeCentralService.js` | Ficha documental com empresa da venda |
| `tests/fiscal/fechamento-caminhos-residuais-certificado-p0-4.test.js` | Suíte 1–24 |
| `tests/fiscal/*p0-1*`, `*p0-2*`, `*p0-3*` | Fixtures alinhadas ao contrato de path admin (SQL legado + rejeição no PUT) |
| `package.json` | Script `test:fiscal-certificado-p0-4` |
| Este relatório | Evidência de aceite |

Sem segunda implementação PKCS#12: reutiliza `ValidarCertificadoA1Service` / gate / `CertificadoEmpresaService`.

---

## 4. Política de autorização do diagnóstico remoto

| Regra | Comportamento |
|---|---|
| Padrão | `remoto !== true` → modo **local**; `consulta_remota_executada: false`; `sefaz_chamado: false` |
| Empresa | `empresaId` obrigatório; sem fallback global |
| Remoto | Exige `autorizacaoTransmissaoSefaz` com tipo `statusServico` (fonte `TESTE_ISOLADO` apenas, mesmo mecanismo P0.8+) |
| Certificado | `exigirCertificadoAptoParaUsoFiscal` **antes** de qualquer consulta |
| Produção UI | Sem token de teste isolado → remoto permanece bloqueado (falha segura) |
| Resposta de bloqueio | Item “Comunicação SEFAZ” em erro; **não** indica consulta concluída |

Não foi criado mecanismo paralelo de autorização.

---

## 5. Comportamento do checklist de faturamento

`inspecionarCertificadoEmpresa`:

- Exige `empresaId` explícito.
- Lê DTO da empresa (`obterConfiguracaoFiscalEmpresa`) — path/senha **não** expostos.
- Apto somente se `certificado_status === VÁLIDO` **e** `apto_certificado_criptografico`.
- Diferencia não configurado, não validado, senha inválida, arquivo inválido, expirado, CNPJ divergente, erro.
- `PRONTA` administrativa **não** implica aptidão criptográfica.
- `revalidar=true` usa fluxo de teste existente (sem SEFAZ); inspeção visual padrão **não** transmite.
- Legado `inspecionarCertificado(config)` devolve não apto.

---

## 6. Gravação e substituição administrativa

1. Empresa identificada no recurso; upload/teste exigem autorização existente.  
2. `certificado_path` no PUT só aceita arquivo sob pasta protegida com nome `certificado-empresa-{id}.pfx`.  
3. Upload válido → `validarArquivoPfx` → snapshot `VÁLIDO` com `confiarSnapshotValidacao: true`.  
4. PUT administrativo com `VÁLIDO` sem flag de confiança → snapshot invalidado.  
5. Troca de path/senha sem snapshot confiável → `CONFIGURADO_NÃO_VALIDADO`.  
6. Falha de validação no upload restaura backup (mecanismo já existente).  
7. Estados administrativos vs criptográficos permanecem distintos.  
8. DTO público sem senha/PFX.  
9. Path externo / traversal / outra empresa: bloqueados na gravação **e** no gate (legado via SQL).

---

## 7. Evidências de isolamento empresarial

| Evidência | Onde |
|---|---|
| Checklist A ≠ path B | P0.4 caso 5 |
| Diagnóstico / gate A≠B | P0.2/P0.3 casos 9; gate em path legado |
| Devolução/ficha usam empresa do documento | P0.4 casos 21–23 (fonte + comportamento) |
| Upload/testar cruzados | P0.1 / certificado-empresa |
| NFC-e 05.46 | 21/21 |

---

## 8. Comandos e resultados dos testes

| Comando | Isolamento | Resultado |
|---|---|---|
| `npm run test:fiscal-certificado-p0-4` | preload → `%TEMP%\cds-preload-*` | **24 ok, 0 falha** |
| `npm run test:fiscal-certificado-p0-1` | preload; DB não carregado | **19 ok** |
| `npm run test:fiscal-certificado-p0-2` | preload; DB não carregado | **19 ok** |
| `npm run test:fiscal-certificado-p0-3` | preload; DB não carregado | **22 ok** |
| `npm run test:fiscal-certificado-empresa` | preload; DB não carregado | **16 ok** |
| `node -r … tests/empresas/gestao-fiscal-visual-05-15.test.js` | preload | **18/18 ok** |
| `npm run test:central-entradas-rc2` | preload → TEMP | **9 passou** |
| `node -r … tests/fiscal/isolamento-nfce-empresa-05-46.test.js` | preload/isolar | **21/21** |

Suíte P0.4 cobre os casos obrigatórios 1–24 (diagnóstico, checklist, gravação, contexto, regressão de gates).

---

## 9. Evidências de isolamento do banco (suítes)

- Preload `tests/central-entradas/helpers/preloadIsolamentoBanco.js` / `isolarBancoTeste`.  
- P0.1–P0.3 e certificado-empresa: `BANCO DE TESTE: database.js não carregado nesta suíte`.  
- P0.4 / rc2 / 05.46: `BANCO DE TESTE COMPROVADO: …\AppData\Local\Temp\cds-preload-*\mercadao.db`.  
- PFX sintéticos em `%TEMP%`; transporte/status SEFAZ simulados ou não invocados.

**Incidente de processo (fora das suítes):** após as regressões, um `require('./backend/database')` acidental **sem** preload no agente de verificação imprimiu o caminho oficial e disparou `ensure`/migrações de schema no banco `C:\ProgramData\MercantilFiscal\dados\mercadao.db`. Isso **não** faz parte dos comandos de teste da microsprint; não houve intenção de alterar NSU/cooldown/filas/Central. Fica registrado como ressalva operacional do ambiente de verificação.

---

## 10. Confirmação de ausência de comunicação SEFAZ fiscal real nas suítes

- Diagnóstico remoto de produção permanece sem `TESTE_ISOLADO` → não chama status autenticado.  
- Casos P0.4 1–2–4–6: local/bloqueio sem `consulta_remota_executada`.  
- Checklist/gravação: sem SOAP.  
- Regressões P0.2/P0.3: transporte simulado; falhas antes do callback.  
- Nenhum DistDFe / 210210 / PFX de produção nas suítes.

**Ressalva:** o diagnóstico **local** ainda resolve DNS e faz ping HTTPS ao host SVRS (conectividade), sem cliente SOAP e sem carregar PFX. Não é consulta `statusServico` autenticada.

---

## 11. Riscos remanescentes e fora do escopo

1. Ping/DNS no diagnóstico local (conectividade, não status autenticado).  
2. Dupla abertura PKCS#12 (gate + assinatura/TLS) permanece.  
3. Autorização remota de diagnóstico em produção exigiria etapa futura de UX/autorização operacional (hoje só TESTE_ISOLADO).  
4. Rotas legadas globais de config que não passam por `salvarConfiguracaoFiscalEmpresa` — se ainda existirem consumidores, o **uso fiscal** continua barrado pelo gate; mapeamento fino de UI legada fora do núcleo desta entrega.  
5. Integração E2E completa de emissão com schema real de venda não foi reaberta (já ressalvada no P0.3).  
6. Commit / push / merge / homologação SEFAZ real — fora do escopo.

---

## 12. Critérios de aceite

| Critério | Status |
|---|---|
| Caminhos residuais mapeados | **OK** |
| Diagnóstico remoto sem autorização não consulta SEFAZ | **OK** |
| Diagnóstico remoto usa empresa/certificado corretos (quando autorizado) | **OK** |
| Checklist não confunde `PRONTA` com validade criptográfica | **OK** |
| Gravação admin não declara válido sem validação | **OK** |
| Substituição malsucedida preserva anterior | **OK** (serviço upload) |
| Uso fiscal não aceita caminho arbitrário | **OK** (gravação + gate) |
| UF/CFOP/emitente sem empresa global incorreta | **OK** |
| Isolamento A/B | **OK** |
| Regressões P0.2 / P0.3 | **OK** |
| Sem acesso oficial / SEFAZ real nas suítes | **OK** (suítes); incidente de verificação documentado |

---

## 13. Decisão

**APROVADA COM RESSALVAS**

Os caminhos residuais prioritários (diagnóstico, checklist, gravação administrativa) e o contexto empresarial de preparação/ficha foram fechados sem enfraquecer os gates P0.2/P0.3. As ressalvas cobrem ping de conectividade no diagnóstico local, autorização remota só via TESTE_ISOLADO, e o incidente de `require` do `database.js` sem preload na verificação pós-teste.
