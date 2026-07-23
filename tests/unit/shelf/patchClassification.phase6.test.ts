import { describe, expect, it } from "vitest";
import { classifyPatchHeader } from "../../../src/shelf/patchClassification";

describe("patch header classification boundaries", () => {
    it("decodes quoted rename paths while ignoring harmless trailing spaces", () => {
        const patch = Buffer.from(
            'rename from "old\\040name\\011\\\"quoted\\\"\\\\path.txt"   \r\nrename to next.txt\r\n',
            "utf8",
        );

        expect(classifyPatchHeader(patch)).toEqual({
            status: "R",
            renamedFrom: 'old name\t"quoted"\\path.txt',
            binary: false,
        });
    });

    it("rejects malformed or non-UTF-8 rename metadata without changing its rename status", () => {
        const malformed = Buffer.from('rename from "unsupported\\q"\n', "utf8");
        const invalidUtf8 = Buffer.from([...Buffer.from("rename from ", "utf8"), 0xff, 0x0a]);

        expect(classifyPatchHeader(malformed)).toMatchObject({
            status: "R",
            renamedFrom: undefined,
            binary: false,
        });
        expect(classifyPatchHeader(invalidUtf8)).toMatchObject({
            status: "R",
            renamedFrom: undefined,
            binary: false,
        });
    });

    it("recognizes the non-Git binary header before any following metadata", () => {
        const patch = Buffer.from(
            "Binary files a/image.bin and b/image.bin differ\nnew file mode 100644\n",
            "utf8",
        );

        expect(classifyPatchHeader(patch)).toEqual({
            status: "M",
            renamedFrom: undefined,
            binary: true,
        });
    });
});
