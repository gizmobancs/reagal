const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = 3000;

// Replace with your TicketSource API key
const API_KEY = "skl-J9fLpV5K6RoPnQbCFALr16aANibrWRf4OhxwxENOUu2NFWNtEJdvm8FLNgpa";

// Enable CORS
app.use(cors());

// Serve static files (frontend)
app.use(express.static(path.join(__dirname, "public")));

// Fetch all events with optional filtering by reference
async function fetchAllEvents(apiUrl, reference = null) {
  const allEvents = [];
  let nextUrl = apiUrl;

  try {
    while (nextUrl) {
      console.log("Fetching events with reference:", reference);

      // Include reference if provided
      const params = reference ? { reference } : {};
      const response = await axios.get(nextUrl, {
        headers: { Authorization: `Bearer ${API_KEY}` },
        params: params,
      });

      // Log the full event data to inspect the structure
      console.log("Raw event data fetched:", JSON.stringify(response.data, null, 2));

      allEvents.push(...response.data.data);
      nextUrl = response.data.links?.next || null;
    }
  } catch (error) {
    console.error("Error fetching events:", error.message);
    throw new Error("Failed to fetch events from TicketSource API");
  }

  return allEvents;
}

// Group events by town and include venue and date details
app.get("/api/events", async (req, res) => {
  try {
    const reference = req.query.reference ? req.query.reference.toLowerCase() : null; // Normalize the reference query to lowercase
    console.log("Received reference:", reference); // Log the received reference for debugging

    // Fetch the events with the optional reference filter
    let events = await fetchAllEvents("https://api.ticketsource.io/events", reference);

    // Log the raw events to check if 'reference' is part of the event data
    console.log("Fetched events:", JSON.stringify(events, null, 2));

    // If reference is provided, manually filter the events based on the 'reference' field (case insensitive)
    if (reference) {
      console.log("Filtering events based on reference...");

      // Filter events by reference, using case-insensitive comparison
      events = events.filter(event => {
        const eventReference = event.attributes?.reference?.toLowerCase(); // Normalize the event reference to lowercase
        console.log("Checking event reference:", eventReference); // Log the reference for each event
        return eventReference === reference; // Case-insensitive comparison
      });

      console.log(`Filtered events count after reference filter: ${events.length}`);
    }

    // Fetch venues and dates data for the filtered events
    const venueRequests = events.map((event) =>
      axios.get(event.links.venues, { headers: { Authorization: `Bearer ${API_KEY}` } })
    );
    const dateRequests = events.map((event) =>
      axios.get(event.links.dates, { headers: { Authorization: `Bearer ${API_KEY}` } })
    );

    const venuesResponses = await Promise.all(venueRequests);
    const datesResponses = await Promise.all(dateRequests);

    const groupedEvents = {};
    events.forEach((event, index) => {
      const venues = venuesResponses[index].data.data;
      const dates = datesResponses[index].data.data;

      const town = venues[0]?.attributes.address.line_3 || "Unknown Town";

      if (!groupedEvents[town]) {
        groupedEvents[town] = [];
      }

      const eventDetails = {
        eventName: event.attributes.name,
        description: event.attributes.description,
        thumbnail: event.attributes.images.find((img) => img.type === "thumbnail")?.src || "",
        town,
        fromDate: null,
        toDate: null,
        dates: [],
        reference: event.attributes.reference,  // Include the reference field here
      };

      dates.forEach((date) => {
        const startDate = new Date(date.attributes.start);
        const formattedDate = startDate.toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        });
        const formattedTime = startDate.toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
        });

        eventDetails.dates.push({
          date: formattedDate,
          time: formattedTime,
          bookNowLink: date.links.book_now,
        });

        if (!eventDetails.fromDate || startDate < new Date(eventDetails.fromDate)) {
          eventDetails.fromDate = formattedDate;
        }
        if (!eventDetails.toDate || startDate > new Date(eventDetails.toDate)) {
          eventDetails.toDate = formattedDate;
        }
      });

      groupedEvents[town].push(eventDetails);
    });

    // Send the grouped events as a response
    res.json(groupedEvents);
  } catch (error) {
    console.error("Error fetching or processing events:", error.message);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

// Disable favicon.ico requests
app.get("/favicon.ico", (req, res) => res.status(204).end());

// Fallback route to serve the frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
