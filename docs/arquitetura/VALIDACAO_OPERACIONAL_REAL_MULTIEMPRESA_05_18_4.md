# Validação operacional — configuração fiscal multiempresa (05.18.4)

## Identificador oficial da empresa

`POST /api/empresas` → `EmpresaService.criarEmpresa` → JSON 201 com campo **`id`**.

O frontend usa `resolverEmpresaId` (`id` | `empresa_id` | `empresaId` | `data.id`).

Identificador oficial persistido: `empresas.id`. Nas rotas fiscais: `:empresaId`.

## Configuração fiscal

| Rota | Persistência | Isolamento |
|---|---|---|
| GET/PUT `/api/empresas/:empresaId/configuracao-fiscal` | `empresas_configuracao_fiscal.empresa_id` | body divergente → 409 |
| GET `/api/empresas/configuracao-fiscal/status` | mesma tabela, lista por empresa | complementar; falha não derruba a tela |

GET público: flags + URLs. **Não** devolve `token_csc`, `id_csc` em claro, senha nem path.

PUT parcial: campo omitido/vazio no payload do front **não** entra no PATCH → não apaga CSC. Limpeza deliberada de segredo **não** está exposta na UI (só omitir). Documentado; regra mantida.

## Certificado

`POST /api/fiscal/certificado/upload`

Com `empresa_id` válido → `certificado-empresa-{id}.pfx` + `salvarConfiguracaoFiscalEmpresa`. Sem fallback para empresa 1.

Sem `empresa_id` → `certificado.pfx` **global** (Plataforma Fiscal / EMPRESA_UNICA). LEGADO. A tela Empresas sempre envia o id da edição.

Senha não vai para log.

## CSC

Gravado em `token_csc` / `id_csc` por `empresa_id`. GET só `csc_configurado` / `id_csc_configurado`. Isolamento A≠B comprovado no banco em teste.

## getFiscalConfig

- Sem `empresaId`: GLOBAL (legado EMPRESA_UNICA).
- `empresaId` inválido: `EMPRESA_OBRIGATORIA`.
- Sem linha: `CONFIGURACAO_FISCAL_EMPRESA_AUSENTE`.
- Com linha: só aquela empresa.

## Emissão

`emitirPorVendaId(vendaId, { empresaId })` → `getFiscalConfig({ empresaId })` → bloco do ambiente → `entregarUrlsAoTransporte`.

MUV encaminha `opts` (correção 05.18.3).

## HTTP / visual / PDV Universal nesta sessão

Servidor `127.0.0.1:3001` **indisponível** (conexão recusada). Sem sessão autenticada. Sem browser/Electron.

**VALIDAÇÃO HTTP REAL NÃO EXECUTADA** (além do probe).

**VALIDAÇÃO VISUAL REAL NÃO EXECUTADA.**

PDV Universal: contrato `GET /api/pdv-universal/contexto` permanece no código; não exercitado ao vivo.
