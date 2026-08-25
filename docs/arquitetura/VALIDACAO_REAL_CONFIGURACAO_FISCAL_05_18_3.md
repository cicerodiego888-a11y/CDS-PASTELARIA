# Validação real — configuração fiscal por empresa (05.18.3)

## Caminho comprovado no código

```
PUT /api/empresas/:empresaId/configuracao-fiscal
  → empresas.js → salvarConfiguracaoFiscalEmpresa
  → tabela empresas_configuracao_fiscal (empresa_id)

emitirPorVendaId(vendaId, { empresaId })
  → getFiscalConfig({ empresaId, db })
  → carregarConfiguracaoFiscalEmpresa (sem fallback global)
  → montarConfigEmpresa → resolverUrlsEmpresa
       ambiente 2 → urlsHomologacao
       ambiente 1 → urlsProducao
  → config.urls (bloco ativo)
  → resolverUrlsEmissao(config)
  → entregarUrlsAoTransporte
  → enviarAutorizacao({ url: config.urls.autorizacao })
```

QR e consulta chave: `emissor.js` lê `resolverUrlsEmissao` → `consultaQr` / `consultaChave` do mesmo bloco.

## Fallback global

Acontece **somente** quando `getFiscalConfig()` é chamado **sem** `empresaId` (EMPRESA_UNICA / Plataforma Fiscal / DANFE legado sem `nfce_notas.empresa_id`).

Origem: tabela `configuracoes` (`fiscal_ws_*_homologacao` / `_producao`).

Se `empresaId` é informado:

- inválido → `EMPRESA_OBRIGATORIA` (não cai no global)
- empresa sem linha → `CONFIGURACAO_FISCAL_EMPRESA_AUSENTE`
- empresa com linha → **nunca** lê `configuracoes` fiscais

## Encadeamento MUV

`FiscalizarAtendimentoService` já validava `getFiscalConfig({ empresaId })` e chamava `emitir(vendaId, { empresaId, db })`.

O default `resolverEmissor` descartava o segundo argumento. Corrigido para encaminhar `opts` ao emissor oficial. Sem mudança de contrato de atendimento.

## URLs efetivamente usadas na emissão NFC-e

| Campo | Uso hoje |
|---|---|
| autorizacao (bloco do ambiente) | ATIVO — transporte |
| consultaQr | ATIVO — QRCode |
| consultaChave | ATIVO — `urlChave` no XML |
| retorno | RESERVADO / NÃO UTILIZADO no emissor (`indSinc=1`, sem consulta de recibo) |
| status | RESERVADO — `statusServico.js` usa RegistryBuilder/SVRS, **não** `config.urls.status` |

## Logs

`[FISCAL:CARGA]` / `[FISCAL:AUTORIZACAO]` via `FiscalRuntimeLog`: empresa_id, ambiente, origem, URLs públicas. Sem senha, CSC ou PFX.
