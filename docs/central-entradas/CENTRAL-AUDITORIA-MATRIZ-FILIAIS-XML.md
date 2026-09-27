# Auditoria Central de Entradas — Matriz × Filiais (XML)

## STATUS

Diagnóstico com evidência de banco. Correção no fluxo de **consulta por chave quando o DistDFe está em cooldown de NSU**.

A Matriz **não** “funciona por ser Matriz”. Ela recebeu `procNFe` **no mesmo DistDFe** em que chegou o resumo. As filiais receberam **só `resNFe`**, a ciência (quando aceita) ficou esperando **novo NSU que nunca veio**, e o código **não consultava `consChNFe`** enquanto o cursor NSU da filial estava em cooldown (ultNSU = maxNSU + cStat 137).

## O que o banco mostra

### Matriz (empresa 1)

- 5× `PROC_NFE` em revisão.
- Ex. NF 430 (id 41): `RESUMO_RECEBIDO` → `XML_COMPLETO` **no mesmo segundo** (`2026-09-15 16:05:26`). DistDFe entregou o XML completo na descarga, sem depender de ciência 135 depois.
- NSU produção: ult = max = **107**, último cStat 137.

### Filial 2 (…0003-87)

- 12× `XML_INDISPONIVEL` (ciência **596**, prazo 10 dias).
- 3× `RESUMO_RECEBIDO` com ciência **135** (ex. 252929, 543363).
- Motor de recuperação bateu `consChNFe` **dezenas/centenas de vezes** nos 596 (ex. NF 183346: 97 consultas) com **CNPJ da Filial 2** (após MULTICNPJ-01). **Nenhum `procNFe` persistido.**
- NSU: ult = max = **15**, cStat **137**.

### Filial 3 (…0002-04)

- 4× `XML_INDISPONIVEL` (596) — **zero** `RECUPERACAO_XML_CONSULTA` (fila do motor monopolizada pelos XML_INDISPONIVEL mais antigos da Filial 2).
- 4× `RESUMO_RECEBIDO` com ciência **135** (4422, 184468, 184732, 184934).
- Depois da ciência: loop `AGUARDANDO_NSU` / `AGUARDANDO_JANELA_SEFAZ` / `CONSULTA_PROGRAMADA`.
- **Sem** evento de `consChNFe` (`AGUARDANDO_CHAVE`).
- NSU: ult = max = **8**, cStat **137**.

## Dois problemas distintos

### A) XML_INDISPONIVEL (notas velhas)

Ciência 210210 **depois do prazo** → cStat **596** (HTTP 200, RecepcaoEvento4). O classificador antigo encerrou sem `consChNFe`. Mesmo com retry posterior na Filial 2, a SEFAZ **não devolveu `procNFe`** nessas chaves.

Isso **não** é “a filial não tem certificado”: o log recente de recuperação da NF 183346 usa `empresa_id=2` e CNPJ `…0003-87`.

Pode ser indisponibilidade **real** na SEFAZ (sem ciência no prazo). Não inventar `procNFe`. Caminho restante: Portal Nacional / XML do fornecedor.

### B) RESUMO_RECEBIDO que “fica aguardando” (ciência 135)

Aqui **é bug de orquestração**, não “SEFAZ recusou a filial”.

1. Ciência **aceita** (135) nas filiais — contexto/CNPJ corretos.
2. NT: XML completo vem depois, via DistDFe (novo NSU) ou `consChNFe`.
3. DistDFe da filial já está no fim do cursor (**137**, ult=max).
4. `avaliarCooldown` fica **ativo**.
5. `_consultarDistDfePorNsu` **retornava sem `consChNFe`**.
6. MIRX reagendava janela. A tela mostra resumo para sempre.

Na Matriz o `procNFe` já tinha vindo no DistDFe inicial — esse buraco não aparece.

## Correção aplicada

1. Cooldown de NSU **não cancela** `consChNFe` (CNPJ/PFX do documento).
2. `XML_INDISPONIVEL` tenta `consChNFe` **sem** reenviar 210210.
3. MIRX não descarta mais `XML_INDISPONIVEL`.
4. Motor: lote prioriza quem **menos tentou** (Filial 3 deixa de ficar atrás de 97 retries da Filial 2).
5. UI: resumo e XML indisponível deixam de dizer “não faz nada sozinho” quando há retry automático.

## O que esperar depois do restart (`npm start`)

| Situação | Esperado |
|----------|----------|
| Filial 3 NF 4422 / 184732 / 184934 (ciência 135) | `consChNFe` com PFX da Filial 3. Se a SEFAZ mandar `procNFe`, vira XML completo. Se mandar 137/resNFe, continua resumo **com evidência**, não “esquecido”. |
| Filial 2 XML_INDISPONIVEL 596 | Retry `consChNFe`. Se continuar sem zip, é limitação SEFAZ (prazo), não Matriz no lugar da filial. |
| Matriz | DistDFe/NSU inalterado. |

## Testes

- `central-xml-multicnpj-02` (inclui cooldown NSU + consChNFe Filial 3)
- `rc747-cstat-596-terminal`
- `rc336-recuperacao-xml`

Suíte completa do repositório não executada.
