# INVENTÁRIO FISCAL EMPRESARIAL — Sprint 05.46

**Status:** auditoria concluída (2026-08-25)  
**Escopo:** NFC-e (modelo 65), certificado e CSC usados na operação da venda.  
**Fora de escopo desta correção:** NF-e 55, DistDFe, Motor Comercial, TEF, estoque, financeiro, lotes, reservas.

Fonte de verdade da operação fiscal da venda: `vendas.empresa_id`.  
Configuração empresarial já existente: `empresas_configuracao_fiscal` (04.08/04.09).  
Legado global: tabela `configuracoes` (`fiscal_*`).

---

## 1. Como o projeto realmente resolve configuração

| Origem | Quando | Certificado / CSC / série / ambiente |
|--------|--------|--------------------------------------|
| `getFiscalConfig({ empresaId })` | `empresaId` válido | `empresas_configuracao_fiscal` + cadastro `empresas`. **Sem fallback global.** Código: `CONFIGURACAO_FISCAL_EMPRESA_AUSENTE` |
| `getFiscalConfig()` | sem `empresaId` | tabela `configuracoes` (`fonte: 'GLOBAL'`). CSC `fiscal_token_csc`, certificado `fiscal_certificado_path` |
| Numeração empresa | `incrementaNumeroFiscal({ empresaId })` | `MAX(numero)` em `nfce_notas` filtrado por `serie + ambiente + empresa_id` + `numero_atual` da empresa |
| Numeração global | `incrementaNumeroFiscal()` sem empresa | `MAX(numero)` por série/ambiente **sem** `empresa_id` + `fiscal_numero_atual` |

Não existe tabela nova a criar. Não existe motor fiscal paralelo.

---

## 2. Fluxo × arquivo × resolução

| Fluxo | Arquivo | Como resolve empresa | Como resolve certificado |
|-------|---------|----------------------|--------------------------|
| Emissão PDV pós-venda | `VendaFiscalService.js` → `emissor.emitirPorVendaId(vendaId)` | **não passa** `empresaId`; emissor usa `opcoes.empresaId` ou nada | `getFiscalConfig(fiscalOpts)` — sem id → **GLOBAL** |
| Emissão HTTP | `rotas/fiscal.js` `POST /emitir/venda/:vendaId` | **não** anexa empresa; `emitirPorVendaId(vendaId)` | idem GLOBAL |
| Emissão MUV | `FiscalizarAtendimentoService.js` | `atendimento_operacoes.empresa_id` passado em `opts.empresaId` | `getFiscalConfig({ empresaId })` depois emissor com o mesmo id |
| Emissão (núcleo) | `emissor.js` `emitirPorVendaId` | `opcoes.empresaId` (não lê `vendas.empresa_id`) | `getFiscalConfig({ empresaId })` ou global |
| Cancelamento venda | `VendaCancelamentoService` → `cancelarNfceAutorizadaVenda` | ownership 05.42 na venda; **não** passa empresa ao cancelar NFC-e | `cancelarNfce` → `getFiscalConfig()` **GLOBAL** |
| Cancelamento HTTP | `rotas/fiscal.js` `POST /notas/:id/cancelar` | nota por `id` global; `cancelarNfce(venda_id)` | **GLOBAL** |
| Cancelamento núcleo | `cancelarNfce.js` | só `venda_id` da nota; não lê `vendas.empresa_id` | `getFiscalConfig()` linha 10 **GLOBAL** |
| DANFE | `emissor.obterDanfeHtmlAtualizado` | `nota.empresa_id` se houver, senão global | `getFiscalConfig(empresaNota ? {empresaId} : {})` |
| Lista NFC-e | `GET /fiscal/notas` | **nenhuma** | N/A (leitura) |
| Detalhe NFC-e | `GET /fiscal/notas/:id` | **nenhuma** | N/A |
| Config admin empresa | `empresasConfiguracaoFiscal.js` + rotas `/api/empresas/:id/configuracao-fiscal` | `params.empresaId` | path+senha da linha da empresa |
| Upload PFX | `rotas/fiscal.js` | body `empresa_id` → arquivo `certificado-empresa-{id}.pfx`; sem id → `certificado.pfx` global | grava path na config da empresa ou global |
| Plataforma Fiscal UI | `GET/PUT /api/fiscal/config` | perfil global | `configuracoes` |
| NF-e 55 emissão | `nfeEmissorVenda.js` | não | `getFiscalConfig()` global |
| Cancelamento NF-e 55 | `cancelarNfe.js` | não | `getFiscalConfig()` global |
| DistDFe | `distribuicaoDFe.js` | contexto DistDFe 05.43 | `getFiscalConfig({ validarUrls:false })` global / empresa DistDFe |
| Relatórios / painel | `nfeOperacionalService`, `CentralFaturamentoService` | misto | `getFiscalConfig()` sem venda |

---

## 3. CSC / série / ambiente / risco

| Fluxo | CSC | Série | Ambiente | Classe | Risco |
|-------|-----|-------|----------|--------|-------|
| `emitirPorVendaId` sem `opcoes.empresaId` | global `fiscal_token_csc` | `fiscal_serie` | `fiscal_ambiente` | **D** | Venda A emite com credencial global ou de outra empresa se o global for o “último” |
| `emitirPorVendaId` com `empresaId` (MUV) | CSC da empresa do **opt**, não necessariamente `vendas.empresa_id` | série da empresa do opt | ambiente da empresa do opt | **D** se opt ≠ venda; **B** se MUV garante igualdade | opt pode divergir da venda |
| `cancelarNfce` | sempre global | UF/ambiente globais no XML do evento | global | **D** | NFC-e A cancelada com certificado B/global |
| `incrementaNumeroFiscal` sem empresa | MAX global série+ambiente | global | global | **D** no caminho PDV | numeração A/B misturada |
| `incrementaNumeroFiscalEmpresa` | N/A | série da empresa | ambiente da empresa | **A** | isolado se chamado |
| `getFiscalConfig({ empresaId })` | token/id da linha `empresa_id` | `row.serie` | `row.ambiente` | **A** | seguro **quando** o id é o da venda |
| `GET /notas` `/notas/:id` | — | — | — | **D** | leitura cruzada |
| `GET/PUT /fiscal/config` | global | global | global | **C** | EMPRESA_UNICA / Plataforma Fiscal; não é emissão de venda |
| Upload sem `empresa_id` | — | — | — | **C** | perfil global intencional |
| NF-e 55 / DistDFe / devolução 55 | global | global | global | **C** | não é NFC-e da venda PDV; 04.08 deixou explícito |
| `qrcode.js` | CSC passado pelo caller | — | `tpAmb` do caller | **B** | herda a config já resolvida |
| `FiscalizarAtendimentoService` | config da operação | da config | da config | **A/B** | cadeia atendimento→empresa; emissor deve passar a usar `vendas.empresa_id` |
| `usuario` / caixa / COMPAT | não usados no emissor hoje | — | — | — | não são fonte atual; proibir como fallback |
| `backend/teste_cancelar.js` | — | — | — | **E** | script debug |
| `CaixaWidget` / dashboard caixa | — | — | — | **E** | fora do fiscal |

Nenhuma classe foi inventada: cada linha corresponde a leitura do código citado.

---

## 4. Padrões perigosos encontrados

```
cancelarNfce.js          getFiscalConfig()                    // sem empresa
VendaFiscalService.js    emitirPorVendaId(vendaId)            // sem empresa da venda
rotas/fiscal.js          emitirPorVendaId(vendaId)            // sem empresa
emissor.js               fiscalOpts = empresaId ? {empresaId} : {}
                         // empresaId só de opcoes, não de vendas.empresa_id
incrementaNumeroFiscal() SELECT MAX(numero) ... sem empresa_id
GET /notas               SELECT n.* FROM nfce_notas            // global
nfce_notas por venda_id  ORDER BY id DESC LIMIT 1              // OK se a venda já for da empresa
```

Não há `COMPAT` silencioso de empresa no emissor NFC-e. O fallback real é **configuração GLOBAL** quando `empresaId` não é passado.

---

## 5. Cadeia alvo (após correção)

```
vendas.empresa_id
        ↓
empresa fiscal (única)
        ↓
empresas_configuracao_fiscal WHERE empresa_id = ?
        ├── certificado_path / senha
        ├── token_csc / id_csc
        ├── ambiente / série / numero_atual
        └── URLs do ambiente
        ↓
NFC-e (autorização / cancelamento / DANFE / leitura)
```

`empresaId` do request: **autorização**. Divergência → `VENDA_NAO_ENCONTRADA` (404).  
`empresa_id IS NULL` na venda → `EMPRESA_OWNERSHIP_REQUIRED` **antes** de numerar/transmitir.
