package org.freshehr;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.ehrbase.openehr.sdk.webtemplate.model.WebTemplate;
import org.ehrbase.openehr.sdk.webtemplate.parser.OPTParser;
import org.openehr.schemas.v1.OPERATIONALTEMPLATE;
import org.openehr.schemas.v1.TemplateDocument;

import java.io.File;

/**
 * Converts an openEHR operational template (OPT XML) into the web template JSON
 * consumed by mb-auto-form (Track A) and the custom renderer (Track C).
 *
 * Usage: WebTemplateGen &lt;input.opt&gt; &lt;output.json&gt;
 *
 * Mirrors openFHIR's OpenEhrTemplateUtils, which is the reference for the
 * OPTParser call sequence.
 */
public final class WebTemplateGen {

    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            System.err.println("Usage: WebTemplateGen <input.opt> <output.json>");
            System.exit(2);
        }

        File input = new File(args[0]);
        if (!input.isFile()) {
            System.err.println("OPT not found: " + input.getAbsolutePath());
            System.exit(2);
        }

        File output = new File(args[1]);
        File parent = output.getAbsoluteFile().getParentFile();
        if (parent != null) {
            parent.mkdirs();
        }

        OPERATIONALTEMPLATE opt = TemplateDocument.Factory.parse(input).getTemplate();
        WebTemplate webTemplate = new OPTParser(opt).parse();

        new ObjectMapper().writerWithDefaultPrettyPrinter().writeValue(output, webTemplate);

        System.out.printf("Wrote %s (templateId=%s)%n",
                output.getPath(), webTemplate.getTemplateId());
    }
}
