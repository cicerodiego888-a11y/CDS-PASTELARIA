# Relatório — Implementação 03.29
## MTS / transferências — auditoria + contexto multiempresa

**Data:** 2026-08-21 · **Status:** concluída (sem alteração no motor)

---

## 1. Fluxos auditados

`MtsService.transferirSaldo`, `consultarTransferencia`, Motor Comercial (`mts.transferirSaldo`), Pedido operacional, Pedido/Expedição (`PedidoService`), porta `transferirSaldoEntreTipos` (não usada pelo MTS).

## 2. Fluxos alterados

Nenhum. Stop rule: o MTS já propaga `empresaId` quando o caller informa.

## 3. Fluxos descartados

Transferência entre empresas (não existe). Rotas HTTP MTS (não existem). Reservas (MTS não reserva). `UPDATE produtos`. Reescrita do motor. Motor Comercial. Pedido/Faturamento (outro domínio).

## 4. Origem real do empresaId

Contrato interno: `params.empresaId` (depois `params.empresa_id` via `resolverEmpresaId(params)`). Motor Comercial já envia `portaOpts.empresaId`. Callers HTTP de Pedido **não** enviam.

## 5. COMPAT

`COMPAT_CERTIFICADA_PRE_MULTIEMPRESA` / `modoLegadoSemEmpresa`. Sem empresa 1. Sem CNPJ. Sem fallback novo.

## 6. Portas

`estoqueSaldosPublico.consultarSaldo`, `debitarSaldo`, `creditarSaldo`. Dual-write 03.19 na porta. MTS não chama `EstoqueEmpresaService` nem `transferirSaldoEntreTipos`.

## 7. Transações

TX da porta, ou `jaEmTransacao` no db do caller. Rollback externo restaura `produtos` + `estoque_empresa`.

## 8. Isolamento

Com `empresaId`, F↔NF espelha só na linha daquela empresa. A não altera B.

## 9–10. Testes / regressão

`mts-multiempresa-contexto.test.js`: 10/10 OK.

| Suite | Resultado |
|---|---|
| `mts-multiempresa-contexto.test.js` | 10/10 OK |
| `porta-publica-saldos-multiempresa.test.js` | 17/17 OK |
| `reservas-dual-write-empresa.test.js` | 12/12 OK |
| `mts-v1.test.js` | homologado |
| `muc-public-contract.test.js` | 20/20 OK |
| `rc3161-pedido-motor-comercial-mts.test.js` | homologada |

## 11. Não alterado de propósito

Motor MTS homologado. Motor Comercial. Pedido (não passa `empresaId` — pendência de outro domínio).

## 12. Resultado

1. Isolado por empresa **quando o caller informa empresaId**.  
2. Propaga `empresaId` corretamente no contrato do motor.  
3. Usa as portas públicas.  
4. Contrato homologado intacto.  
5. Sem alterar empresa errada (body/query aninhados não substituem).

Não iniciar a Sprint 03.30.
